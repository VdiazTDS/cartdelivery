import { applyEdits, changedFields, previewMerge, mergeRows } from './merge.mjs';

export function createWorkbookService(db, XLSX) {
  const bucket = db.storage.from('profile-workbooks');
  const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const one = async (table, filters) => {
    let q = db.from(table).select('*');
    for (const [key, value] of Object.entries(filters)) q = q.eq(key, value);
    return unwrap(await q.maybeSingle());
  };
  const read = async path => new Uint8Array(await unwrap(await bucket.download(path)).arrayBuffer());
  const parse = bytes => XLSX.read(bytes, { type: 'array', cellStyles: true, bookVBA: true });
  const rowsOf = wb => XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  async function put(bytes, extension = 'xlsx') {
    const path = `${crypto.randomUUID()}.${extension}`;
    unwrap(await bucket.upload(path, bytes, { upsert: false, contentType: extension === 'csv' ? 'text/csv' : extension === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    return path;
  }
  async function updateWorkbook(path, rows) {
    const wb = parse(await read(path));
    const ws = wb.Sheets[wb.SheetNames[0]];
    const previous = rowsOf(wb);
    if (previous.length !== rows.length) throw new Error('ROW_STRUCTURE_CHANGED');
    const range = XLSX.utils.decode_range(ws['!ref']);
    const columns = new Map();
    for (let col = range.s.c; col <= range.e.c; col++) {
      const key = String(ws[XLSX.utils.encode_cell({ r: range.s.r, c: col })]?.v ?? '');
      if (key) columns.set(key, col);
    }
    rows.forEach((row, index) => {
      for (const field of changedFields(previous[index], row)) {
        if (!columns.has(field)) {
          columns.set(field, ++range.e.c);
          XLSX.utils.sheet_add_aoa(ws, [[field]], { origin: { r: range.s.r, c: range.e.c } });
        }
        XLSX.utils.sheet_add_aoa(ws, [[row[field] ?? '']], { origin: { r: previous[index].__rowNum__, c: columns.get(field) } });
      }
    });
    return put(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
  }
  const signed = async path => unwrap(await bucket.createSignedUrl(path, 300)).signedUrl;
  const pending = c => c?.pending_count || 0;
  const describe = (f, c) => ({ fileId: f.id, name: f.name, copyId: c?.id, copyRevision: c?.revision,
    masterRevision: f.revision, pending: pending(c), baseRevision: c?.base_revision });
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  return async function handle(body, actor) {
    if (!actor?.id || !/^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$/.test(actor.email || '')) throw new Error('SIGN_IN_REQUIRED');
    const username = actor.email.split('@')[0];
    unwrap(await db.from('cd_profiles').upsert({ user_id: actor.id, display_name: username }));
    const { action } = body;
    if (action === 'list') {
      const files = unwrap(await db.from('cd_files').select('id,name,revision,source_key').order('name'));
      const copies = unwrap(await db.from('cd_copies').select('id,file_id,revision,base_revision,pending_count').eq('owner_id', actor.id));
      return { username, files: files.map(f => ({ ...describe(f, copies.find(c => c.file_id === f.id)), sourceKey: f.source_key })) };
    }
    const mutating = ['import', 'open', 'save', 'sync'].includes(action);
    let hash;
    if (mutating) {
      if (!uuid(body.requestId)) throw new Error('INVALID_REQUEST_ID');
      hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))))).map(x => x.toString(16).padStart(2, '0')).join('');
      const receipt = await one('cd_receipts', { actor_id: actor.id, request_id: body.requestId });
      if (receipt) {
        if (receipt.request_hash !== hash) throw new Error('REQUEST_REUSED');
        return { ...receipt.result, ...(receipt.result.path ? { url: await signed(receipt.result.path) } : {}) };
      }
    }
    async function commit(payload) {
      const result = unwrap(await db.rpc('cd_commit', { p_action: action, p_actor: actor.id, p_request: body.requestId, p_hash: hash, p: payload }));
      return { ...result, ...(result.path ? { url: await signed(result.path) } : {}) };
    }
    if (action === 'import') {
      const source = body.sourceKey;
      let name = body.name;
      if (source && (typeof source !== 'string' || source.includes('/') || !/\.(xlsx|xls|csv)$/i.test(source))) throw new Error('INVALID_FILE');
      if (typeof name !== 'string' || name.length > 180 || /[\/\\\x00-\x1f]/.test(name) || !/\.(xlsx|xls|csv)$/i.test(name)) throw new Error('INVALID_FILE');
      const extension = name.split('.').pop().toLowerCase();
      name = name.replace(/\.(xls|csv)$/i, '.xlsx');
      let bytes;
      if (source) bytes = new Uint8Array(await unwrap(await db.storage.from('excel-files').download(source)).arrayBuffer());
      else {
        if (typeof body.base64 !== 'string' || body.base64.length > 28_000_000) throw new Error('FILE_TOO_LARGE');
        bytes = Uint8Array.from(atob(body.base64), c => c.charCodeAt(0));
      }
      if (bytes.byteLength > 20_000_000) throw new Error('FILE_TOO_LARGE');
      const wb = parse(bytes);
      if (wb.vbaraw) throw new Error('INVALID_MACRO_WORKBOOK');
      const rows = rowsOf(wb);
      if (!rows.length || rows.length > 100_000) throw new Error('INVALID_ROW_COUNT');
      const headers = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0].filter(v => v != null && v !== '').map(String);
      if (new Set(headers).size !== headers.length) throw new Error('DUPLICATE_HEADERS');
      const originalPath = await put(bytes, extension);
      const path = extension === 'xlsx' ? originalPath : await put(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
      return commit({ id: crypto.randomUUID(), name, source_key: source || null, original_path: originalPath, path, rows });
    }
    if (!uuid(body.fileId)) throw new Error('INVALID_FILE');
    const f = await one('cd_files', { id: body.fileId });
    if (!f) throw new Error('FILE_NOT_FOUND');
    if (action === 'history') {
      const offset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
      const history = unwrap(await db.from('cd_syncs').select('id,profile_name,created_at,before_revision,after_revision,changes,resolutions')
        .eq('file_id', f.id).order('created_at', { ascending: false }).order('id').range(offset, offset + 24));
      return { history };
    }
    if (action === 'original') return { ...describe(f), url: await signed(f.workbook_path), mode: 'original' };
    const c = await one('cd_copies', { file_id: f.id, owner_id: actor.id });
    if (action === 'open') {
      if (c) return { ...describe(f, c), url: await signed(c.workbook_path) };
      const path = await put(await read(f.workbook_path));
      return commit({ file_id: f.id, master_revision: f.revision, id: crypto.randomUUID(), path });
    }
    if (!c) throw new Error('COPY_NOT_FOUND');
    if (action === 'preview') return { ...describe(f, c), changes: previewMerge(c.base_rows, c.rows, f.rows) };
    if (body.copyRevision !== c.revision) throw new Error('STALE_VERSION');
    if (action === 'save') {
      const rows = applyEdits(c.rows, body.edits);
      const path = await updateWorkbook(c.workbook_path, rows);
      return commit({ file_id: f.id, copy_revision: c.revision, rows, path });
    }
    if (action === 'sync') {
      if (body.masterRevision !== f.revision) throw new Error('STALE_VERSION');
      const merged = mergeRows(c.base_rows, c.rows, f.rows, body.resolutions || []);
      const path = merged.changes.length ? await updateWorkbook(f.workbook_path, merged.rows) : f.workbook_path;
      const copyPath = await put(await read(path));
      return commit({ file_id: f.id, copy_revision: c.revision, master_revision: f.revision,
        ...merged, path, copy_path: copyPath });
    }
    throw new Error('INVALID_ACTION');
  };
}
