importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
importScripts('profile-field-mapping.js?v=20261012-field-mapping');

let rows;
let mapping;
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
      if (headers.some(header => header.length > 200 || ['__proto__', 'constructor', 'prototype', '__rowNum__'].includes(header))) throw new Error('INVALID_HEADERS');
      rows = XLSX.utils.sheet_to_json(sheet);
      if (!rows.length || rows.length > 100000) throw new Error('INVALID_ROW_COUNT');
      mapping = data.mapping || null;
      if (mapping && CartDeliveryFields.errors(mapping, headers).length) throw new Error('INVALID_MAPPING');
      const samples = Object.fromEntries(headers.map(header => [header, rows.slice(0, 5).map(row => row[header] ?? '')]));
      self.postMessage({ rowCount: rows.length, headers, samples, sheetName: workbook.SheetNames[0] });
    } else {
      const batch = [];
      let length = 0;
      for (let index = data.offset; index < rows.length && batch.length < 250; index++) {
        const row = CartDeliveryFields.apply(rows[index], mapping);
        const size = JSON.stringify(row).length;
        if (size > 60000) throw new Error('INVALID_ROW');
        if (batch.length && length + size > 450000) break;
        batch.push(row); length += size;
      }
      self.postMessage({ rows: batch });
    }
  } catch (error) { self.postMessage({ error: error.message || 'INVALID_FILE' }); }
};
