const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./profile-workbooks.fixture.cjs');
(async () => {
  const fx = await fixture();
  const { pg, actor, call, state, objects, workbook, handle, XLSX } = fx;
  try {
    const a = await actor('team_a'), b = await actor('team_b');
    const rows = [0, 1, 2].map(index => ({ ID: index, QTY: 3, ROUTE: 'A', DAY: 1, 'CSADR#': 100 + index, CSSTRT: 'Test', BINNO: `00${index}`, LATITUDE: 30.75 + index * .001, LONGITUDE: -98.23, del_qty: 0, del_status: '' }));
    const initialBytes = workbook(rows);
    const imported = await call(a, 'import', { name: 'Trash.xlsx', base64: Buffer.from(initialBytes).toString('base64') });
    const fileId = imported.fileId;
    const original = async () => (await pg.query('select * from cd_files where id=$1', [fileId])).rows[0];
    const copy = async who => (await pg.query('select * from cd_copies where file_id=$1 and owner_id=$2', [fileId, who.id])).rows[0];
    const originalPath = (await original()).workbook_path;
    assert.deepEqual(objects.get('profile-workbooks/' + (await original()).original_path), initialBytes, 'Exact uploaded file retained');
    const [oa, ob] = await Promise.all([call(a, 'open', { fileId }), call(b, 'open', { fileId })]);
    assert.notEqual(oa.copyId, ob.copyId);
    assert.notEqual((await copy(a)).workbook_path, (await copy(b)).workbook_path);
    await assert.rejects(() => call(a, 'import', { name: 'Trash.xlsx', base64: Buffer.from(initialBytes).toString('base64') }), /NAME_EXISTS/);
    const edit = (index, count) => ({ index, values: { del_qty: count, del_status: count === 3 ? 'Delivered' : '' } });
    await Promise.all([call(a, 'save', { fileId, copyRevision: 1, edits: [edit(0, 1), edit(2, 1)] }), call(b, 'save', { fileId, copyRevision: 1, edits: [edit(1, 1), edit(2, 1)] })]);
    assert.deepEqual((await original()).rows, rows, 'Profile saves never change original');
    assert.equal((await copy(a)).rows[1].del_qty, 0, 'Copies remain isolated');
    await assert.rejects(() => call(a, 'save', { fileId, copyRevision: 1, edits: [edit(0, 2)] }), /STALE_VERSION/);
    await assert.rejects(() => call(a, 'save', { fileId, copyRevision: 2, edits: [{ index: 0, values: { QTY: 10 } }] }), /INVALID_FIELDS/);
    state.failUpload = true;
    await assert.rejects(() => call(a, 'save', { fileId, copyRevision: 2, edits: [edit(0, 2)] }));
    state.failUpload = false;
    assert.equal((await copy(a)).revision, 2);
    state.failCommit = true;
    await assert.rejects(() => call(a, 'save', { fileId, copyRevision: 2, edits: [edit(0, 2)] }));
    state.failCommit = false;
    assert.equal((await copy(a)).revision, 2, 'Failed commit cannot publish the uploaded candidate workbook');
    const pa = await call(a, 'preview', { fileId }), pb = await call(b, 'preview', { fileId });
    assert.equal(pa.changes.length, 2);
    const syncA = { action: 'sync', fileId, copyRevision: pa.copyRevision, masterRevision: pa.masterRevision, resolutions: [], requestId: randomUUID() };
    const resultA = await handle(syncA, a);
    assert.deepEqual(await handle(syncA, a), resultA, 'Retry returns exactly the same committed operation');
    await assert.rejects(() => handle({ ...syncA, resolutions: [{ index: 2, choice: 'original' }] }, a), /REQUEST_REUSED/);
    await assert.rejects(() => call(b, 'sync', { fileId, copyRevision: pb.copyRevision, masterRevision: pb.masterRevision, resolutions: [] }), /STALE_VERSION/);
    const overlap = await call(b, 'preview', { fileId });
    assert.deepEqual(overlap.changes.filter(r => r.conflict).map(r => r.index), [2], 'Equal delivered counts still flag overlap');
    await assert.rejects(() => call(b, 'sync', { fileId, copyRevision: 2, masterRevision: 2, resolutions: [] }), /UNRESOLVED_CONFLICT/);
    await call(b, 'sync', { fileId, copyRevision: 2, masterRevision: 2, resolutions: [{ index: 2, choice: 'count', count: 2 }] });
    assert.deepEqual((await original()).rows.map(row => row.del_qty), [1, 1, 2]);
    assert.equal((await call(b, 'preview', { fileId })).changes.length, 0, 'Sync advances baseline; no double counting');
    const finalBytes = objects.get('profile-workbooks/' + (await original()).workbook_path);
    const finalBook = XLSX.read(finalBytes, { type: 'array' });
    assert.equal(finalBook.Sheets['Keep formula'].A1.f, '1+2');
    assert.deepEqual(XLSX.utils.sheet_to_json(finalBook.Sheets.Stops).map(r => r.del_qty), [1, 1, 2]);
    assert(objects.has('profile-workbooks/' + originalPath), 'Seed workbook retained');
    const history = await call(a, 'history', { fileId });
    assert.equal(history.history.length, 2);
    assert.deepEqual(new Set(history.history.map(h => h.profile_name)), new Set(['team_a', 'team_b']));
    assert(history.history[0].changes.some(change => change.index === 2 && change.fields.some(field => field.before === 1 && field.after === 2)));
    // A stale preflight can still race: the SQL commit must reject it under its lock.
    const snapshot = await original();
    const c = await copy(a);
    const payload = { file_id: fileId, copy_revision: c.revision, master_revision: 2, rows: snapshot.rows, path: snapshot.workbook_path, copy_path: snapshot.workbook_path, changes: [], resolutions: [] };
    const failed = await fx.db.rpc('cd_commit', { p_action: 'sync', p_actor: a.id, p_request: randomUUID(), p_hash: 'race', p: payload });
    assert.match(failed.error.message, /STALE_VERSION/);
    const cActor = await actor('team_c');
    await assert.rejects(() => call(cActor, 'save', { fileId, copyId: oa.copyId, copyRevision: 1, edits: [edit(0, 3)] }), /COPY_NOT_FOUND/);
    await assert.rejects(() => handle({ action: 'list' }, null), /SIGN_IN_REQUIRED/);
    // Existing broad bucket policies cannot let old clients overwrite originals.
    await pg.exec("insert into storage.objects(bucket_id,name) values('excel-files','Trash.xlsx'); set role authenticated;");
    assert.equal((await pg.query("update storage.objects set name='Overwritten.xlsx' where name='Trash.xlsx' returning *")).rows.length, 0);
    await assert.rejects(() => pg.query("insert into storage.objects(bucket_id,name) values('profile-workbooks','bad.xlsx')"), /row-level security/);
    await assert.rejects(() => pg.query('select * from public.cd_copies'), /permission denied/);
    await assert.rejects(() => pg.query("select public.cd_commit('sync',$1,$2,'x','{}')", [a.id, randomUUID()]), /permission denied/);
    await pg.exec('reset role');
    const { mergeRows } = await import('../supabase/functions/profile-workbooks/merge.mjs');
    const merged = mergeRows([rows[0]], [{ ...rows[0], del_qty: 1 }], [{ ...rows[0], del_qty: 3, del_status: 'Delivered' }], [{ index: 0, choice: 'mine' }]);
    assert.equal(merged.rows[0].del_status, '', 'Quantity and status resolve together');
    // Both requests finish preflight before either enters the SQL transaction.
    function rendezvous(action) {
      let arrived = 0, release;
      const gate = new Promise(resolve => { release = resolve; });
      state.beforeCommit = async args => {
        if (args.p_action !== action) return;
        if (++arrived === 2) release();
        await gate;
      };
    }
    const refreshA = await call(a, 'preview', { fileId });
    await call(a, 'sync', { fileId, copyRevision: refreshA.copyRevision, masterRevision: refreshA.masterRevision, resolutions: [] });
    const commonRevision = (await copy(a)).revision;
    rendezvous('save');
    const competingSaves = await Promise.allSettled([
      call(a, 'save', { fileId, copyRevision: commonRevision, edits: [edit(0, 2)] }),
      call(a, 'save', { fileId, copyRevision: commonRevision, edits: [edit(0, 3)] })
    ]);
    state.beforeCommit = null;
    assert.equal(competingSaves.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(competingSaves.find(r => r.status === 'rejected').reason.message, /STALE_VERSION/);
    assert.equal((await copy(a)).revision, commonRevision + 1);
    await call(b, 'save', { fileId, copyRevision: (await copy(b)).revision, edits: [edit(1, 2)] });
    const [raceA, raceB] = await Promise.all([call(a, 'preview', { fileId }), call(b, 'preview', { fileId })]);
    rendezvous('sync');
    const competingSyncs = await Promise.allSettled([a, b].map((who, index) => {
      const view = index ? raceB : raceA;
      return call(who, 'sync', { fileId, copyRevision: view.copyRevision, masterRevision: view.masterRevision, resolutions: [] });
    }));
    state.beforeCommit = null;
    assert.equal(competingSyncs.filter(r => r.status === 'fulfilled').length, 1);
    const losingTeam = [a, b][competingSyncs.findIndex(r => r.status === 'rejected')];
    const newReview = await call(losingTeam, 'preview', { fileId });
    assert(newReview.changes.every(r => !r.conflict), 'Disjoint edits stay available after race');
    await call(losingTeam, 'sync', { fileId, copyRevision: newReview.copyRevision, masterRevision: newReview.masterRevision, resolutions: [] });
    assert.equal((await original()).rows[0].del_qty, (await copy(a)).rows[0].del_qty);
    assert.equal((await original()).rows[1].del_qty, 2);
    assert.equal((await original()).rows[2].del_qty, 2);
    console.log('PASS: actual PostgreSQL migration/permissions/CAS, profile isolation, overlap review, idempotency, quantity merge, audit, immutable workbooks and formula preservation.');
  } finally { await pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
