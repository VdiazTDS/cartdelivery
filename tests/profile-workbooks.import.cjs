const assert = require('node:assert/strict');
const { fixture } = require('./profile-workbooks.fixture.cjs');

(async () => {
  const fx = await fixture();
  const { XLSX, call, pg, objects, state } = fx;
  try {
    const user = await fx.actor('import_test');
    const rows = Array.from({ length: 5364 }, (_, index) => ({
      ID: index, QTY: 3, ROUTE: 'A', DAY: 1,
      ...Object.fromEntries(Array.from({ length: 32 }, (_, col) => [`FIELD_${col}`, `Sample ${index}-${col}`]))
    }));
    const bytes = fx.workbook(rows);
    objects.set('excel-files/Large.xlsx', bytes);
    const { fileId } = await call(user, 'import', { name: 'Large.xlsx', sourceKey: 'Large.xlsx' });
    const imported = (await pg.query('select * from cd_files where id=$1', [fileId])).rows[0];
    assert.deepEqual(imported.rows, rows);
    assert.deepEqual(objects.get('profile-workbooks/' + imported.original_path), bytes);
    const opened = await call(user, 'open', { fileId });
    const saved = await call(user, 'save', { fileId, copyRevision: opened.copyRevision,
      edits: [{ index: 5363, values: { del_qty: 1, del_status: '' } }] });
    const savedBook = XLSX.read(objects.get('profile-workbooks/' + saved.path), { type: 'array' });
    const savedRows = XLSX.utils.sheet_to_json(savedBook.Sheets.Stops);
    assert.deepEqual(savedRows[5363], { ...rows[5363], del_qty: 1, del_status: '' });
    assert.deepEqual(savedRows[0], rows[0]);
    assert.equal(savedBook.Sheets['Keep formula'].A1.f, '1+2');

    for (const bookType of ['xlsx', 'xls', 'csv']) {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([]);
      XLSX.utils.sheet_add_aoa(ws, [['ID', 'QTY'], [1, 3], [], [2, 2]], { origin: 'B3' });
      ws['!ref'] = 'B3:C6';
      ws.C4.z = '0.00';
      XLSX.utils.book_append_sheet(wb, ws, 'Stops');
      const input = XLSX.write(wb, { type: 'buffer', bookType });
      const imported = await call(user, 'import', { name: `Offset-${bookType}.${bookType}`, base64: input.toString('base64') });
      const copy = await call(user, 'open', { fileId: imported.fileId });
      const saved = await call(user, 'save', { fileId: imported.fileId, copyRevision: copy.copyRevision,
        edits: [{ index: 1, values: { del_qty: 1, del_status: '' } }] });
      const output = XLSX.read(objects.get('profile-workbooks/' + saved.path), { type: 'array', cellStyles: true });
      const outputRows = XLSX.utils.sheet_to_json(output.Sheets.Stops || output.Sheets[output.SheetNames[0]]);
      assert.equal(outputRows.length, 2);
      assert.equal(outputRows[1].ID, 2);
      assert.equal(outputRows[1].del_qty, 1, 'Blank worksheet rows do not shift edits');
      if (bookType !== 'csv') assert.equal(output.Sheets.Stops.C4.z, '0.00');
    }
    const duplicate = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(duplicate, XLSX.utils.aoa_to_sheet([['ID', 'ID'], [1, 2]]), 'Stops');
    const uploadCount = state.uploads.length;
    await assert.rejects(() => call(user, 'import', { name: 'Duplicate.xlsx',
      base64: XLSX.write(duplicate, { type: 'buffer', bookType: 'xlsx' }).toString('base64') }), /DUPLICATE_HEADERS/);
    assert.equal(state.uploads.length, uploadCount);
    console.log('PASS: 5,364-row/36-column legacy import, copy/save, untouched bytes and formulas, XLSX/XLS/CSV, offset headers, blank rows, number formats, duplicate rejection. Fake storage only.');
  } finally { await pg.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
