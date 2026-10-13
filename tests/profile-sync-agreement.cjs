const assert = require('node:assert/strict');
const { fixture } = require('./profile-data.fixture.cjs');

(async () => {
  const fx = await fixture();
  try {
    const a = await fx.actor('agreement_a'), b = await fx.actor('agreement_b');
    const rows = Array.from({ length: 13 }, (_, ID) => ({ ID, QTY: 3, del_qty: 0, del_status: '', delivery_notes: '' }));
    rows[0].QTY = 1;
    rows[6].del_qty = 1;
    Object.assign(rows[7], { del_qty: 3, del_status: 'Delivered' });
    Object.assign(rows[8], { del_qty: '', del_status: ' delivered ' });
    rows[9].QTY = rows[10].QTY = '';
    const { fileId } = await fx.importRows(a, 'Agreement.xlsx', rows);
    const ac = await fx.call(a, 'open', { fileId }), bc = await fx.call(b, 'open', { fileId });
    const count = (index, qty, notes) => ({ index, values: { del_qty: qty, del_status: qty === rows[index].QTY ? 'Delivered' : '', ...(notes === undefined ? {} : { delivery_notes: notes }) } });
    const note = (index, text) => ({ index, values: { delivery_notes: text } });
    const unknown = (index, notes) => ({ index, values: { del_qty: '', del_status: 'Delivered', ...(notes ? { delivery_notes: notes } : {}) } });
    await fx.call(a, 'save', { fileId, copyRevision: ac.copyRevision, edits: [
      count(0, 1), count(1, 1), count(2, 1), note(3, 'Mine'), count(4, 1, 'Mine'), count(5, 1),
      count(6, 0), count(7, 1), count(8, 3, 'Mine'), unknown(9), unknown(10), note(11, 'Same'), count(12, 1)
    ] });
    const bs = await fx.call(b, 'save', { fileId, copyRevision: bc.copyRevision, edits: [
      count(0, 1), count(1, 1), note(2, 'Team'), count(3, 2), count(4, 1, 'Team'), count(5, 2),
      count(6, 2), count(7, 1), count(8, 1), unknown(9), note(10, 'Team'), note(11, 'Same'), count(12, 3)
    ] });
    await fx.call(b, 'sync', { fileId, copyRevision: bs.copyRevision, masterRevision: bc.masterRevision, resolutions: [] });
    const preview = await fx.call(a, 'preview', { fileId });
    assert.deepEqual(preview.changes.filter(item => item.conflict).map(item => item.index), [4, 5, 6, 12]);
    for (const index of [0, 1, 7, 9, 11]) assert.deepEqual(preview.changes.find(item => item.index === index).fields, [], 'Matching reports are no-ops');
    assert.deepEqual(preview.changes.find(item => item.index === 4).fields, ['delivery_notes'], 'Equal counts cannot be overwritten by a note decision');
    assert.deepEqual(preview.changes.find(item => item.index === 8).fields, ['delivery_notes'], 'Legacy representation change must not revert a team correction');
    const sync = { fileId, copyRevision: preview.copyRevision, masterRevision: preview.masterRevision, resolutions: [] };
    const before = await fx.read(a, fileId, 'original');
    await assert.rejects(() => fx.call(a, 'sync', sync), /UNRESOLVED_CONFLICT/);
    assert.deepEqual(await fx.read(a, fileId, 'original'), before, 'An unresolved conflict rolls back even earlier automatic merges');
    await fx.call(a, 'sync', { ...sync, resolutions: [{ index: 4, choice: 'mine' }, { index: 5, choice: 'count', count: 3 }, { index: 6, choice: 'original' }, { index: 12, choice: 'original' }] });
    const after = await fx.read(a, fileId, 'original');
    assert.deepEqual(after.map(row => row.del_qty), [1, 1, 1, 2, 1, 3, 2, 1, 1, '', '', 0, 3]);
    for (const index of [2, 10]) assert.equal(after[index].delivery_notes, 'Team');
    for (const index of [3, 4, 8]) assert.equal(after[index].delivery_notes, 'Mine');
    assert.equal(after[0].del_status, 'Delivered'); assert.equal(after[12].del_status, 'Delivered');
    assert.equal(after[9].del_status, 'Delivered'); assert.equal(after[10].del_status, 'Delivered');
    assert.deepEqual(await fx.read(a, fileId), after, 'Sync refreshes the entire profile baseline');
    assert.equal((await fx.call(a, 'preview', { fileId })).pending, 0);
    await fx.pg.exec('set role authenticated');
    await assert.rejects(() => fx.pg.query("select public.cd_data_delivery_value('{}')"), /permission denied/);
    await fx.pg.exec('reset role');
    assert.equal(fx.state.uploads.length, 0);
    console.log('PASS: delivery agreement, partial counts, corrections, independent/competing notes, legacy counts, unknown QTY, atomic conflict rejection and refreshed copies.');
  } finally { await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
