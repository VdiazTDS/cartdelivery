const assert = require('node:assert/strict');
const { fixture } = require('./profile-data.fixture.cjs');
(async () => {
  const fx = await fixture();
  try {
    const actor = await fx.actor('driver_a');
    const { fileId } = await fx.importRows(actor, 'Team.xlsx', [{ QTY: 3, ID: 1 }]);
    const copy = await fx.call(actor, 'open', { fileId });
    const saved = await fx.call(actor, 'save', { fileId, copyRevision: copy.copyRevision, edits: [{ index: 0, values: { del_qty: 2, del_status: '' } }] });
    const before = fx.state.commits.length;
    const publicCall = (action, fields = {}) => fx.handle({ action, ...fields }, null);
    const list = await publicCall('public-list');
    assert.equal(list.files.length, 1);
    assert.equal(list.files[0].copyId, null);
    assert.equal(list.files[0].pending, 0);
    const view = await publicCall('public-original', { fileId });
    const page = await publicCall('public-rows', { fileId, mode: 'original', masterRevision: view.masterRevision, offset: 0, copyId: copy.copyId });
    assert.equal(page.rows[0].del_qty, null, 'Public view never reveals unshared profile changes');
    assert.equal(fx.state.commits.length, before, 'Public browsing creates no profile, copy, or receipt');
    for (const action of ['save', 'sync', 'open', 'rows', 'history', 'import-start', 'list', 'export-source']) {
      await assert.rejects(() => publicCall(action, { fileId }), /SIGN_IN_REQUIRED/);
    }
    await assert.rejects(() => publicCall('public-rows', { fileId, mode: 'copy', masterRevision: view.masterRevision, offset: 0 }), /INVALID_PUBLIC_VIEW/);
    await assert.rejects(() => fx.db.rpc('cd_data_public_read', { p: { action: 'save', fileId } }).then(x => { if (x.error) throw x.error; }), /SIGN_IN_REQUIRED/);
    await fx.call(actor, 'sync', { fileId, copyRevision: saved.copyRevision, masterRevision: view.masterRevision, resolutions: [] });
    await assert.rejects(() => publicCall('public-rows', { fileId, mode: 'original', masterRevision: view.masterRevision, offset: 0 }), /STALE_VERSION/);
    const latest = await publicCall('public-original', { fileId });
    assert.equal((await publicCall('public-rows', { fileId, mode: 'original', masterRevision: latest.masterRevision, offset: 0 })).rows[0].del_qty, 2);
    const source = await publicCall('public-export-source', { fileId });
    assert.deepEqual(Object.keys(source), ['url']);
    fx.objects.set('excel-files/Partial.xlsx', fx.workbook([{ QTY: 1 }]));
    const partial = await fx.call(actor, 'import-start', { name: 'Partial.xlsx', sourceKey: 'Partial.xlsx' });
    assert.equal((await publicCall('public-list')).files.length, 1);
    await assert.rejects(() => publicCall('public-original', { fileId: partial.fileId }), /FILE_NOT_FOUND/);
    await assert.rejects(() => publicCall('public-export-source', { fileId: partial.fileId }), /FILE_NOT_FOUND/);
    const rights = (await fx.pg.query("select has_function_privilege('anon','public.cd_data_public_read(jsonb)','EXECUTE') anon, has_function_privilege('authenticated','public.cd_data_public_read(jsonb)','EXECUTE') signed, has_function_privilege('service_role','public.cd_data_public_read(jsonb)','EXECUTE') server")).rows[0];
    assert.deepEqual(rights, { anon: false, signed: false, server: true });
    console.log('PASS: anonymous team views show confirmed shared data only; copies, writes, history and incomplete imports stay protected; revisions and server-only RPC verified.');
  } finally { await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
