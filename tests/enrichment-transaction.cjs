const assert = require('node:assert/strict');
const { fixture } = require('./profile-data.fixture.cjs');
const { enrichmentSql, protectedTables } = require('../scripts/enrichment-transaction.cjs');
(async () => {
  const fx = await fixture();
  const { pg, call, actor, importRows, read } = fx;
  try {
    const a = await actor('driver_a'), b = await actor('driver_b');
    const { fileId } = await importRows(a, 'Enrichment.xlsx', [{ UNIQUE: 1, QTY: 3 }, { UNIQUE: 2, QTY: 2 }]);
    await pg.query("update cd_data_files set source_bucket='profile-workbooks',source_path='original.xlsx',source_digest='original' where id=$1", [fileId]);
    await pg.exec("insert into storage.objects(bucket_id,name) values('profile-workbooks','enriched.xlsx')");
    let av = await call(a, 'open', { fileId }), bv = await call(b, 'open', { fileId });
    await call(a, 'save', { fileId, copyRevision: av.copyRevision, edits: [{ index: 0, values: { del_qty: 3, del_status: 'Delivered', delivery_notes: 'Synced note' } }] });
    const preview = await call(a, 'preview', { fileId });
    await call(a, 'sync', { fileId, copyRevision: preview.copyRevision, masterRevision: preview.masterRevision, resolutions: [] });
    await call(b, 'save', { fileId, copyRevision: bv.copyRevision, edits: [{ index: 1, values: { del_qty: 1, del_status: '', delivery_notes: 'Private pending note' } }] });
    const rowsBefore = await read(b, fileId), sharedBefore = await read(a, fileId, 'original');
    const snapshots = async () => {
      const data = {};
      for (const table of protectedTables) data[table] = (await pg.query(`select * from ${table} order by to_jsonb(${table})::text`)).rows;
      return data;
    };
    const before = await snapshots();
    const records = (await pg.query('select row_index,md5(data::text) hash from cd_data_records where file_id=$1 order by row_index', [fileId])).rows;
    const plan = { files: [{ id: fileId, old_path: 'original.xlsx', old_digest: 'original', new_path: 'enriched.xlsx', new_digest: 'enriched' }],
      changes: records.map(r => ({ file_id: fileId, row_index: r.row_index, expected_hash: r.hash, fields: { CSNAME: `Service ${r.row_index}`, CBNAME: `Billing ${r.row_index}` } })) };
    const stale = structuredClone(plan); stale.changes[1].expected_hash = '0'.repeat(32);
    await assert.rejects(() => pg.exec(enrichmentSql(stale)), /RECORDS_CHANGED/);
    await pg.exec('rollback');
    assert.equal((await pg.query('select count(*)::int n from cd_data_records where data ? \'CSNAME\'')).rows[0].n, 0, 'Failed batch adds no fields');
    const overwrites = structuredClone(plan); overwrites.changes[0].fields.QTY = 10;
    await assert.rejects(() => pg.exec(enrichmentSql(overwrites)), /EXISTING_FIELD_OVERWRITE/);
    await pg.exec('rollback');
    const delivery = structuredClone(plan); delivery.changes[0].fields.del_qty = 0;
    assert.throws(() => enrichmentSql(delivery));
    await pg.exec('create schema enrichment_test; create table enrichment_test.rows(file_id uuid,row_index integer,fields jsonb,expected_hash text)');
    await pg.query('insert into enrichment_test.rows select * from jsonb_to_recordset($1) as x(file_id uuid,row_index integer,fields jsonb,expected_hash text)', [JSON.stringify(plan.changes.slice(0, 1))]);
    await assert.rejects(() => pg.exec(enrichmentSql(plan, 'enrichment_test.rows')), /INVALID_STAGED_ROWS/);
    await pg.exec('rollback');
    await pg.query('insert into enrichment_test.rows select * from jsonb_to_recordset($1) as x(file_id uuid,row_index integer,fields jsonb,expected_hash text)', [JSON.stringify(plan.changes.slice(1))]);
    await pg.exec(enrichmentSql(plan, 'enrichment_test.rows'));
    assert.deepEqual(await snapshots(), before, 'Copies, pending edits, history, receipts, versions and areas are byte-equivalent');
    const rowsAfter = await read(b, fileId), sharedAfter = await read(a, fileId, 'original');
    const withoutNames = rows => rows.map(({ CSNAME, CBNAME, ...row }) => row);
    assert.deepEqual(withoutNames(rowsAfter), rowsBefore);
    assert.deepEqual(withoutNames(sharedAfter), sharedBefore);
    assert.equal(rowsAfter[1].CSNAME, 'Service 1');
    assert.equal(sharedAfter[0].CSNAME, 'Service 0');
    assert.equal(rowsAfter[1].del_qty, 1); assert.equal(sharedAfter[0].del_qty, 3);
    assert.equal(rowsAfter[1].delivery_notes, 'Private pending note');
    assert.equal((await call(b, 'preview', { fileId })).changes.length, 1, 'Enrichment cannot become a delivery sync conflict');
    await assert.rejects(() => pg.exec(enrichmentSql(plan)), /SOURCE_CHANGED/);
    await pg.exec('rollback');
    console.log('PASS atomic rollback, stale guards, overwrite rejection, shared/profile enrichment, preserved delivered and pending values, history and sync state.');
  } finally { await pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
