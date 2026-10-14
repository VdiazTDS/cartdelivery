const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./profile-data.fixture.cjs');

(async () => {
  const fx = await fixture({ legacySeed: async old => {
    const a = await old.actor('owner_a'), b = await old.actor('driver_b');
    const { fileId } = await old.call(a, 'import', { name: 'Old.xlsx', base64: Buffer.from(old.workbook([{ QTY: 3, ID: 1 }])).toString('base64') });
    await old.call(a, 'open', { fileId }); await old.call(b, 'open', { fileId });
    await old.call(a, 'save', { fileId, copyRevision: 1, edits: [{ index: 0, values: { del_qty: 1, del_status: '' } }] });
    await old.call(a, 'sync', { fileId, copyRevision: 2, masterRevision: 1, resolutions: [] });
    return { a, b, fileId, paths: [...old.objects.keys()] };
  } });
  try {
    const { a, b, fileId: oldId, paths } = fx.legacy;
    const other = await fx.actor('another_driver');
    const keep = await fx.importRows(a, 'Keep.xlsx', [{ QTY: 1 }]);
    const { fileId } = await fx.importRows(a, 'Team.xlsx', [{ QTY: 3 }, { QTY: 2 }]);
    const ca = await fx.call(a, 'open', { fileId }), cb = await fx.call(b, 'open', { fileId });
    const savedRequest = { fileId, copyRevision: ca.copyRevision, requestId: randomUUID(), edits: [{ index: 0, values: { del_qty: 1, del_status: '' } }] };
    await fx.call(a, 'save', savedRequest);
    await fx.call(a, 'sync', { fileId, copyRevision: 2, masterRevision: 1, resolutions: [] });
    await fx.call(b, 'save', { fileId, copyRevision: cb.copyRevision, edits: [{ index: 1, values: { del_qty: 1, del_status: '' } }] });
    await fx.pg.query("insert into cd_work_areas(file_id,areas) values($1,'[{\"id\":\"test-area\"}]')", [fileId]);
    const preview = await fx.call(other, 'delete-preview', { fileId });
    assert.equal(preview.copyCount, 2); assert.equal(preview.pendingCount, 1);
    assert.equal(preview.historyCount, 1); assert.equal(preview.areaCount, 1);
    const request = { fileId, requestId: randomUUID(), confirmName: 'Team.xlsx', confirmation: 'Confirm', acknowledged: true };
    await assert.rejects(() => fx.call(null, 'delete-team-file', request), /SIGN_IN_REQUIRED/);
    for (const confirmation of [undefined, '', 'confirm', 'Team.xlsx']) {
      await assert.rejects(() => fx.call(other, 'delete-team-file', { ...request, confirmation }), /INVALID_DELETE_CONFIRMATION/);
    }
    const invalidRpc = await fx.db.rpc('cd_file_delete_call', { p_actor: other.id, p_username: 'another_driver', p_request: request.requestId, p_hash: null, p: { ...request, action: 'delete-start', confirmation: 'Team.xlsx' } });
    assert.match(invalidRpc.error.message, /INVALID_DELETE_CONFIRMATION/, 'Database also requires the confirmation word');
    await assert.rejects(() => fx.call(other, 'delete-team-file', { ...request, confirmName: 'Keep.xlsx' }), /INVALID_DELETE_CONFIRMATION/);
    await assert.rejects(() => fx.call(other, 'delete-team-file', { ...request, acknowledged: false }), /INVALID_DELETE_CONFIRMATION/);
    await fx.pg.query("update auth.users set raw_app_meta_data='{\"cartdelivery_disabled\":true}' where id=$1", [other.id]);
    await assert.rejects(() => fx.call(other, 'delete-team-file', request), /PROFILE_DISABLED/);
    await fx.pg.query("update auth.users set raw_app_meta_data='{}' where id=$1", [other.id]);
    assert.equal((await fx.call(b, 'open', { fileId })).pending, 1, 'Opening/cancelling a preview changes no work');
    fx.state.failCommit = true;
    await assert.rejects(() => fx.call(other, 'delete-team-file', request), /Simulated commit/);
    fx.state.failCommit = false;
    assert(fx.objects.has('excel-files/Team.xlsx'), 'A failed transaction never deletes storage');
    fx.objects.set('excel-files/_cart-delivery-tab.json', Buffer.from(JSON.stringify(['Team.xlsx', 'Keep.xlsx', 'Old.xlsx'])));
    fx.state.failRemove = true;
    const incomplete = await fx.call(other, 'delete-team-file', { ...request, sourceBucket: 'excel-files', sourcePath: 'Keep.xlsx' });
    assert.equal(incomplete.deleted, false); assert.equal(incomplete.deleting, true);
    assert.equal(incomplete.objects, undefined, 'Internal storage plan stays server-side');
    for (const table of ['cd_data_files', 'cd_data_records', 'cd_data_versions', 'cd_data_copies', 'cd_data_history', 'cd_work_areas']) {
      const key = table === 'cd_data_files' ? 'id' : 'file_id';
      assert.equal((await fx.pg.query(`select count(*)::int n from ${table} where ${key}=$1`, [fileId])).rows[0].n, 0, table);
    }
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_drafts where copy_id=$1', [cb.copyId])).rows[0].n, 0);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_history_changes')).rows[0].n, 1, 'Only unrelated migrated history remains');
    assert.equal((await fx.pg.query("select count(*)::int n from cd_data_receipts where result->>'fileId'=$1", [fileId])).rows[0].n, 0);
    await assert.rejects(() => fx.call(a, 'save', savedRequest), /FILE_DELETED/, 'An old successful receipt cannot revive deleted work');
    await assert.rejects(() => fx.call(b, 'open', { fileId }), /FILE_DELETED/);
    await assert.rejects(() => fx.handle({ action: 'public-original', fileId }), /FILE_NOT_FOUND/);
    await assert.rejects(() => fx.call(b, 'work-areas-save', { fileId, mode: 'original', revision: 1, areas: [] }), /FILE_NOT_FOUND/);
    await assert.rejects(() => fx.call(a, 'import-start', { name: 'Team.xlsx', sourceKey: 'Team.xlsx' }), /FILE_DELETED/);
    const list = await fx.call(b, 'list');
    assert.equal(list.deletions.length, 1); assert(list.deletedSourceKeys.includes('Team.xlsx'));
    assert.equal((await fx.handle({ action: 'public-list' })).deletions, undefined, 'Guests cannot manage pending deletion');
    fx.state.failRemove = false; fx.state.failShortcutWrite = true;
    assert.equal((await fx.call(b, 'delete-team-file', request)).deleted, false, 'Shortcut cleanup failure stays retryable');
    assert(!fx.objects.has('excel-files/Team.xlsx'));
    fx.state.failShortcutWrite = false;
    assert.equal((await fx.call(b, 'delete-team-file', request)).deleted, true, 'Any profile can finish cleanup');
    assert.equal((await fx.call(other, 'delete-team-file', request)).deleted, true, 'Lost response retries are idempotent');
    assert.deepEqual(JSON.parse(Buffer.from(fx.objects.get('excel-files/_cart-delivery-tab.json')).toString()), ['Keep.xlsx', 'Old.xlsx']);
    assert(fx.objects.has('excel-files/Keep.xlsx'), 'Client storage paths cannot target another file');
    assert.equal((await fx.call(a, 'original', { fileId: keep.fileId })).rowCount, 1);
    assert.equal((await fx.call(a, 'list')).deletions.length, 0);

    const oldResult = await fx.call(other, 'delete-team-file', { fileId: oldId, confirmName: 'Old.xlsx', confirmation: 'Confirm', acknowledged: true });
    assert(oldResult.deleted);
    for (const path of paths) assert(!fx.objects.has(path), `Migrated source/copy/history object removed: ${path}`);
    for (const table of ['cd_files', 'cd_copies', 'cd_syncs', 'cd_receipts']) assert.equal((await fx.pg.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_history_changes')).rows[0].n, 0);

    fx.objects.set('excel-files/Legacy.csv', Buffer.from('QTY\n1'));
    const sourceId = randomUUID();
    await fx.pg.query('insert into storage.objects(id,bucket_id,name) values($1,$2,$3)', [sourceId, 'excel-files', 'Legacy.csv']);
    const legacy = await fx.call(b, 'delete-preview', { sourceKey: 'Legacy.csv' });
    assert.equal(legacy.sourceObjectId, sourceId);
    await assert.rejects(() => fx.call(b, 'delete-team-file', { sourceKey: 'Legacy.csv', sourceObjectId: randomUUID(), confirmName: 'Legacy.csv', confirmation: 'Confirm', acknowledged: true }), /INVALID_DELETE_TARGET/);
    const partial = await fx.call(a, 'import-start', { name: 'Legacy.csv', sourceKey: 'Legacy.csv' });
    await fx.call(a, 'import-batch', { fileId: partial.fileId, offset: 0, rows: [{ QTY: 1 }] });
    const deletedLegacy = await fx.call(b, 'delete-team-file', { sourceKey: 'Legacy.csv', sourceObjectId: sourceId, confirmName: 'Legacy.csv', confirmation: 'Confirm', acknowledged: true });
    assert(deletedLegacy.deleted); assert(!fx.objects.has('excel-files/Legacy.csv'));
    assert(deletedLegacy.fileIds.includes(partial.fileId), 'Imports started since preview are deleted too');
    await assert.rejects(() => fx.call(a, 'import-finish', { fileId: partial.fileId, rowCount: 1 }), /INVALID_IMPORT/);

    const importRequest = { name: 'Private.xlsx', digest: 'a'.repeat(64), requestId: randomUUID() };
    const uploaded = await fx.call(a, 'import-start', importRequest);
    fx.objects.set('profile-workbooks/' + uploaded.upload.path, fx.workbook([{ QTY: 1 }]));
    await fx.call(a, 'import-batch', { fileId: uploaded.fileId, offset: 0, rows: [{ QTY: 1 }] });
    await fx.call(a, 'import-finish', { fileId: uploaded.fileId, rowCount: 1 });
    fx.state.beforeCommit = async args => { if (args.p.action === 'delete-finish') throw new Error('Lost finalize transaction'); };
    const privateRequest = { fileId: uploaded.fileId, confirmName: 'Private.xlsx', confirmation: 'Confirm', acknowledged: true };
    assert.equal((await fx.call(b, 'delete-team-file', privateRequest)).deleted, false);
    assert(!fx.objects.has('profile-workbooks/' + uploaded.upload.path));
    fx.state.beforeCommit = null;
    const retries = await Promise.all([fx.call(a, 'delete-team-file', privateRequest), fx.call(b, 'delete-team-file', privateRequest)]);
    assert(retries.every(result => result.deleted), 'Concurrent retries finish the same cleanup safely');
    await assert.rejects(() => fx.call(a, 'import-start', importRequest), /FILE_DELETED/, 'A stale private import receipt cannot recreate a deleted upload');
    const replacement = await fx.call(a, 'import-start', { name: 'Private.xlsx', digest: 'b'.repeat(64) });
    assert.notEqual(replacement.fileId, uploaded.fileId, 'A deliberate new upload may reuse the name');
    assert((await fx.call(b, 'delete-team-file', privateRequest)).deleted);
    assert.equal((await fx.pg.query('select count(*)::int n from cd_data_files where id=$1', [replacement.fileId])).rows[0].n, 1, 'An old deletion retry cannot delete the replacement');
    const rights = (await fx.pg.query("select has_function_privilege('anon','public.cd_file_delete_call(uuid,text,uuid,text,jsonb)','EXECUTE') anon, has_function_privilege('authenticated','public.cd_file_delete_call(uuid,text,uuid,text,jsonb)','EXECUTE') signed")).rows[0];
    assert.deepEqual(rights, { anon: false, signed: false });
    assert.equal((await fx.pg.query('select count(*)::int n from cd_profiles')).rows[0].n, 3, 'Profile accounts remain');
    console.log('PASS: any signed-in profile, exact confirmation, full cascading cleanup, migrated workbooks, legacy imports, atomic failures, storage/shortcut recovery, safe retries, source isolation and browser-role denial.');
  } finally { await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
