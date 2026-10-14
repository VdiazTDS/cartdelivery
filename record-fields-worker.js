importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

let sheet, sourceRows, range;
self.onmessage = ({ data }) => {
  try {
    if (data.bytes || data.workbook) {
      const workbook = data.workbook || XLSX.read(new Uint8Array(data.bytes), { type: 'array', dense: true, sheets: 0 });
      sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet?.['!ref']) throw new Error('ROW_STRUCTURE_CHANGED');
      range = XLSX.utils.decode_range(sheet['!ref']);
      sourceRows = XLSX.utils.sheet_to_json(sheet).map(row => row.__rowNum__);
      if (sourceRows.length !== data.expectedCount) throw new Error('ROW_STRUCTURE_CHANGED');
      self.postMessage({ id: data.id, ready: true });
      return;
    }
    if (!sourceRows || !Number.isInteger(data.index) || data.index < 0 || data.index >= sourceRows.length) throw new Error('ROW_STRUCTURE_CHANGED');
    const at = (r, c) => Array.isArray(sheet) ? sheet[r]?.[c] : sheet[XLSX.utils.encode_cell({ r, c })];
    const fields = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = at(sourceRows[data.index], c), heading = at(range.s.r, c);
      fields.push({ column: XLSX.utils.encode_col(c), name: String(heading?.v ?? '') || `Column ${XLSX.utils.encode_col(c)} (no heading)`,
        value: cell?.v == null ? '' : XLSX.utils.format_cell(cell) });
    }
    self.postMessage({ id: data.id, fields, sheetRow: sourceRows[data.index] + 1 });
  } catch (error) { self.postMessage({ id: data.id, error: error.message || 'INVALID_FILE' }); }
};
