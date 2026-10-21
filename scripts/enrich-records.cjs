const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const XLSX = require('../local-artifacts/test-tools/node_modules/xlsx');
const context = { self: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../profile-field-mapping.js'), 'utf8'), context);
const mapping = context.self.CartDeliveryFields;
const normalize = value => String(value ?? '').trim().toUpperCase();
const protectedFields = new Set(['del_qty', 'del_status', 'delivery_notes']);

function columns(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  return Array.from({ length: range.e.c - range.s.c + 1 }, (_, index) => {
    const col = range.s.c + index;
    return { name: String(sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })]?.v ?? ''), col };
  });
}

function prepareEnrichment(master, original, records, fieldMapping) {
  original = structuredClone(original);
  const masterSheet = master.Sheets[master.SheetNames[0]], sheet = original.Sheets[original.SheetNames[0]];
  const masterRows = XLSX.utils.sheet_to_json(masterSheet), rows = XLSX.utils.sheet_to_json(sheet);
  const headers = columns(sheet), sourceHeaders = columns(masterSheet);
  assert.equal(new Set(sourceHeaders.map(c => c.name)).size, sourceHeaders.length, 'Duplicate master headings');
  assert.equal(new Set(headers.map(c => c.name)).size, headers.length, 'Duplicate source headings');
  assert.equal(records.length, rows.length, 'Source/database row count mismatch');
  const recordsByIndex = new Map(records.map(record => [record.row_index, record]));
  const index = new Map(), targetCounts = new Map();
  for (const row of masterRows) {
    const id = normalize(row.UNIQUE);
    if (id) { if (!index.has(id)) index.set(id, []); index.get(id).push(row); }
  }
  for (const row of rows) { const id = normalize(row.UNIQUE); targetCounts.set(id, (targetCounts.get(id) || 0) + 1); }
  const missing = sourceHeaders.filter(({ name }) => name && !headers.some(c => c.name === name) && !protectedFields.has(name));
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const output = structuredClone(original), outputSheet = output.Sheets[output.SheetNames[0]];
  missing.forEach(({ name }, offset) => XLSX.utils.sheet_add_aoa(outputSheet, [[name]], { origin: { r: range.s.r, c: range.e.c + offset + 1 } }));
  const changes = [], matches = [], skipped = [];
  rows.forEach((row, rowIndex) => {
    const record = recordsByIndex.get(rowIndex);
    assert(record, `Missing database record ${rowIndex}`);
    assert.deepEqual(JSON.parse(JSON.stringify(mapping.apply(row, fieldMapping))), record.data, `Source/database identity mismatch at ${rowIndex}`);
    const id = normalize(row.UNIQUE), candidates = index.get(id) || [];
    let reason = !id ? 'Missing UNIQUE' : targetCounts.get(id) !== 1 ? 'Duplicate UNIQUE in team file'
      : !candidates.length ? 'UNIQUE absent from master' : candidates.length !== 1 ? 'Duplicate UNIQUE in master' : '';
    const candidate = candidates[0];
    if (!reason) {
      const identity = ['BINNO', 'CUSTID', 'RS_ADR#', 'RS_DIR', 'RS_STRT', 'RS_SUFX', 'RS_DIR2', 'RS_APT#', 'RS_ZIP5'];
      const different = identity.filter(key => Object.hasOwn(row, key) && normalize(row[key]) !== normalize(candidate[key]));
      if (different.length) reason = `Identity check differs: ${different.join(', ')}`;
      if (!normalize(row['RS_ADR#']) || !normalize(row.RS_STRT)) reason ||= 'Missing address corroboration';
    }
    if (reason) { skipped.push({ rowIndex, sheetRow: row.__rowNum__ + 1, UNIQUE: row.UNIQUE, reason }); return; }
    const fields = {};
    missing.forEach(({ name, col }, offset) => {
      const value = candidate[name] ?? null;
      // Canonical mapped address fields already exist in database rows. Preserve them.
      if (!Object.hasOwn(record.data, name)) fields[name] = value;
      const sourceCell = masterSheet[XLSX.utils.encode_cell({ r: candidate.__rowNum__, c: col })];
      if (sourceCell && sourceCell.v != null) {
        const cell = { t: sourceCell.t, v: sourceCell.v };
        if (sourceCell.z) cell.z = sourceCell.z;
        outputSheet[XLSX.utils.encode_cell({ r: row.__rowNum__, c: range.e.c + offset + 1 })] = cell;
      }
    });
    matches.push({ rowIndex, sheetRow: row.__rowNum__ + 1, masterSheetRow: candidate.__rowNum__ + 1, UNIQUE: row.UNIQUE });
    if (Object.keys(fields).length) changes.push({ file_id: record.file_id, row_index: rowIndex, fields });
  });
  const bytes = XLSX.write(output, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
  const roundTrip = XLSX.read(bytes, { type: 'buffer', cellStyles: true });
  assert.deepEqual(roundTrip.SheetNames, original.SheetNames);
  for (const name of original.SheetNames) {
    for (const [address, cell] of Object.entries(original.Sheets[name])) {
      if (address.startsWith('!') || cell.v == null) continue;
      const actual = roundTrip.Sheets[name][address];
      assert(actual, `Lost original cell ${name}!${address}`);
      for (const key of ['t', 'v', 'f']) assert.deepEqual(actual[key], cell[key], `Changed original cell ${name}!${address} ${key}`);
      assert.equal(actual.z || 'General', cell.z || 'General', `Changed original cell format ${name}!${address}`);
    }
  }
  assert.equal(XLSX.utils.sheet_to_json(roundTrip.Sheets[roundTrip.SheetNames[0]]).length, rows.length);
  return { bytes, changes, matches, skipped, columns: missing.map(c => c.name) };
}

module.exports = { prepareEnrichment, columns };
