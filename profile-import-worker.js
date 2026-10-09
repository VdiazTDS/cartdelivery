importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

let rows;
self.onmessage = ({ data }) => {
  try {
    if (data.bytes) {
      const workbook = XLSX.read(new Uint8Array(data.bytes), { type: 'array', dense: true, sheets: 0, cellText: false, bookVBA: true });
      if (workbook.vbaraw) throw new Error('INVALID_MACRO_WORKBOOK');
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet?.['!ref']) throw new Error('INVALID_ROW_COUNT');
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const headers = (sheet[range.s.r] || []).slice(range.s.c, range.e.c + 1).map(cell => cell?.v).filter(value => value != null && value !== '').map(String);
      if (new Set(headers).size !== headers.length) throw new Error('DUPLICATE_HEADERS');
      rows = XLSX.utils.sheet_to_json(sheet);
      if (!rows.length || rows.length > 100000) throw new Error('INVALID_ROW_COUNT');
      self.postMessage({ rowCount: rows.length });
    } else {
      const batch = [];
      let length = 0;
      for (let index = data.offset; index < rows.length && batch.length < 250; index++) {
        const size = JSON.stringify(rows[index]).length;
        if (size > 60000) throw new Error('INVALID_ROW');
        if (batch.length && length + size > 450000) break;
        batch.push(rows[index]); length += size;
      }
      self.postMessage({ rows: batch });
    }
  } catch (error) { self.postMessage({ error: error.message || 'INVALID_FILE' }); }
};
