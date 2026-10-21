const assert = require('node:assert/strict');
const XLSX = require('../local-artifacts/test-tools/node_modules/xlsx');
const { prepareEnrichment } = require('../scripts/enrich-records.cjs');
const workbook = rows => {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops'); return wb;
};
const rows = [1, 2, 3, 4, 5, 6].map(UNIQUE => ({ UNIQUE, 'RS_ADR#': 100, RS_STRT: 'Oak', BINNO: 1,
  ROUTE: 'Original', DAY: 1, QTY: 3, del_qty: 2, delivery_notes: 'Keep this note' }));
const records = rows.map((data, row_index) => ({ file_id: 'sample', row_index, data }));
const masterRows = rows.map(row => ({ ...row, CSNAME: 'Service ' + row.UNIQUE, CBNAME: 'Billing ' + row.UNIQUE,
  ROUTE: 'Changed', DAY: 7, QTY: 9, del_qty: 0, del_status: '', delivery_notes: 'Wrong note' }));
masterRows.splice(1, 1);
masterRows.push({ ...masterRows.find(r => r.UNIQUE === 3), CSNAME: 'Conflicting duplicate' });
masterRows.find(r => r.UNIQUE === 4).RS_STRT = 'Different street';
masterRows.find(r => r.UNIQUE === 5).BINNO = 2;
masterRows.find(r => r.UNIQUE === 6).CSNAME = '<img src=x onerror=alert(1)>';
const original = workbook(rows), before = structuredClone(original);
const result = prepareEnrichment(workbook(masterRows), original, records, null);
assert.deepEqual(original, before, 'Original workbook is immutable');
assert.deepEqual(result.matches.map(r => r.UNIQUE), [1, 6]);
assert.deepEqual(result.skipped.map(r => r.UNIQUE), [2, 3, 4, 5]);
assert.deepEqual(result.columns, ['CSNAME', 'CBNAME']);
for (const change of result.changes) assert.deepEqual(Object.keys(change.fields).sort(), ['CBNAME', 'CSNAME']);
const enriched = XLSX.utils.sheet_to_json(XLSX.read(result.bytes, { type: 'buffer' }).Sheets.Stops);
for (let i = 0; i < rows.length; i++) for (const key of Object.keys(rows[i])) assert.equal(enriched[i][key], rows[i][key]);
assert.equal(enriched[1].CSNAME, undefined, 'Unmatched rows are unchanged');
assert.equal(enriched[5].CSNAME, '<img src=x onerror=alert(1)>');
assert.throws(() => prepareEnrichment(workbook(masterRows), original, records.slice(1), null), /row count/);
assert.throws(() => prepareEnrichment(workbook(masterRows), original, records.map(r => ({ ...r, data: { ...r.data, QTY: 99 } })), null), /identity mismatch/);
const mappedSource = workbook([{ UNIQUE: 1, BINNO: 1, 'RS_ADR#': 100, RS_STRT: 'Oak', QTY: 3 }]);
const mappedData = { UNIQUE: 1, BINNO: 1, 'RS_ADR#': 100, RS_STRT: 'Oak', 'CSADR#': 100, CSSTRT: 'Oak', QTY: 3 };
const mapped = prepareEnrichment(workbook([{ ...mappedData, 'CSADR#': 999, CSSTRT: 'Other customer address', CSNAME: 'Name' }]), mappedSource,
  [{ file_id: 'sample', row_index: 0, data: mappedData }], { 'CSADR#': 'RS_ADR#', CSSTRT: 'RS_STRT', BINNO: 'BINNO', QTY: 'QTY' });
assert.equal(mapped.changes[0].fields['CSADR#'], undefined, 'Mapped app address is never overwritten');
assert.equal(XLSX.utils.sheet_to_json(XLSX.read(mapped.bytes, { type: 'buffer' }).Sheets.Stops)[0]['CSADR#'], 999, 'Missing raw address column remains available in all-fields source');
console.log('PASS strict ID/corroboration matching, duplicate/missing/conflicting abstention, preserved delivery fields, immutable sources, mapped address separation, and row identity guards.');
