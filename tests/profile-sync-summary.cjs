const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fixture } = require('./profile-data.fixture.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const context = vm.createContext({});
for (const name of ['searchCartQuantity', 'cartTotal', 'storedCartCount', 'isDeliveredRow', 'deliveredCartCount', 'profileSyncImpact']) {
  vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\r?\\n}`))[0], context);
}
for (const name of ['rowRoute', 'rowDay']) vm.runInContext(source.match(new RegExp(`function ${name}[^\\r\\n]+`))[0], context);
const impact = (preview, choices) => JSON.parse(JSON.stringify(context.profileSyncImpact(preview, choices)));
(async () => {
  const fx = await fixture();
  try {
    const a = await fx.actor('summary_a'), b = await fx.actor('summary_b');
    const rows = Array.from({ length: 6 }, (_, index) => ({
      ID: index, QTY: '3', ROUTE: index < 3 ? 'Trash' : 'Recycle', DAY: index < 3 ? 1 : 2,
      NEWROUTE: 'Ignore', NEWDAY: 7, del_qty: index === 1 ? 3 : 0, del_status: index === 1 ? 'Delivered' : '', delivery_notes: ''
    }));
    const file = await fx.importRows(a, 'Summary.xlsx', rows);
    const copy = await fx.call(a, 'open', { fileId: file.fileId });
    await fx.call(a, 'save', { fileId: file.fileId, copyRevision: copy.copyRevision, edits: [
      { index: 0, values: { del_qty: 3, del_status: 'Delivered' } },
      { index: 1, values: { del_qty: 1, del_status: '' } },
      { index: 2, values: { del_qty: 1, del_status: '', delivery_notes: 'Mine' } },
      { index: 3, values: { delivery_notes: 'Mine' } },
      { index: 4, values: { delivery_notes: 'Mine' } },
      { index: 5, values: { del_qty: 1, del_status: '' } }
    ] });
    const other = await fx.call(b, 'open', { fileId: file.fileId });
    const saved = await fx.call(b, 'save', { fileId: file.fileId, copyRevision: other.copyRevision, edits: [
      { index: 2, values: { del_qty: 2, del_status: '', delivery_notes: 'Team' } },
      { index: 3, values: { del_qty: 1, del_status: '' } },
      { index: 4, values: { del_qty: 1, del_status: '', delivery_notes: 'Team' } },
      { index: 5, values: { del_qty: 1, del_status: '' } }
    ] });
    await fx.call(b, 'sync', { fileId: file.fileId, copyRevision: saved.copyRevision, masterRevision: other.masterRevision, resolutions: [] });
    const preview = await fx.call(a, 'preview', { fileId: file.fileId });
    assert.equal(impact(preview).unresolved, 2);
    const choices = [{ index: 2, choice: 'count', count: 3 }, { index: 4, choice: 'mine' }];
    const summary = impact(preview, choices);
    assert.deepEqual({ ...summary, routes: undefined }, { stops: 5, added: 4, removed: 2, completed: 2, reopened: 1, notes: 3, unknown: 0, unchanged: 1, unresolved: 0, routes: undefined });
    assert.deepEqual(summary.routes.map(group => [group.route, group.day, group.stops]), [['Recycle', '2', 2], ['Trash', '1', 3]]);
    assert.equal(impact(preview, choices.map(choice => choice.index === 2 ? { ...choice, count: null } : choice)).unresolved, 1);
    const zero = impact(preview, choices.map(choice => choice.index === 2 ? { ...choice, count: 0 } : choice));
    assert.equal(zero.removed, 4, 'Zero is a valid corrected total, not an unresolved choice');
    await fx.call(a, 'sync', { fileId: file.fileId, copyRevision: preview.copyRevision, masterRevision: preview.masterRevision, resolutions: choices });
    const actual = await fx.read(a, file.fileId, 'original');
    assert.deepEqual(actual.map(row => row.del_qty), [3, 1, 3, 1, 1, 1]);
    assert.equal(actual[4].delivery_notes, 'Mine', 'A note-only sync preserves the team cart count');
    assert.equal(actual[3].delivery_notes, 'Mine', 'Independent note and count changes merge automatically');
    const history = await fx.call(a, 'history', { fileId: file.fileId, offset: 0 });
    assert.equal(history.history[0].change_count, summary.stops, 'Summary stop count matches the committed transaction');
    const unknown = impact({ changes: [{ index: 0, fields: ['del_status'], original: { QTY: '', del_status: '' }, mine: { QTY: '', del_status: 'Delivered' } }] });
    assert.equal(unknown.unknown, 1); assert.equal(unknown.added, 0);
    console.log('PASS: sync summary matches database results for additions, reductions, completed/reopened stops, notes, all conflict choices, no-op changes and original route/day grouping.');
  } finally { await fx.pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
