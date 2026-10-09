const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const actions = new Set(['list', 'import-start', 'import-batch', 'import-finish', 'open', 'original', 'rows', 'save', 'preview', 'sync', 'history', 'history-changes', 'export-source']);

export function createDataService(db) {
  const signed = async (bucket, path) => unwrap(await db.storage.from(bucket).createSignedUrl(path, 600)).signedUrl;
  return async (body, actor) => {
    if (!actor?.id || !/^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$/.test(actor.email || '')) throw new Error('SIGN_IN_REQUIRED');
    if (!body || !actions.has(body.action)) throw new Error('CLIENT_UPDATE_REQUIRED');
    const mutating = ['import-start', 'import-batch', 'import-finish', 'open', 'save', 'sync'].includes(body.action);
    if (mutating && !uuid(body.requestId)) throw new Error('INVALID_REQUEST_ID');
    if (!['list', 'import-start'].includes(body.action) && !uuid(body.fileId)) throw new Error('INVALID_FILE');
    if (body.action === 'history-changes' && !uuid(body.eventId)) throw new Error('INVALID_HISTORY');
    const json = JSON.stringify(body);
    if (json.length > 12_000_000 || (body.action === 'import-batch' && json.length > 750_000)) throw new Error('INVALID_REQUEST_SIZE');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))).map(x => x.toString(16).padStart(2, '0')).join('');
    const input = { ...body };
    if (body.action === 'import-start') {
      if (typeof body.name !== 'string' || body.name.length > 180 || /[\/\\\x00-\x1f]/.test(body.name) || !/\.(xlsx|xls|csv)$/i.test(body.name)) throw new Error('INVALID_FILE');
      if (body.sourceKey != null && (typeof body.sourceKey !== 'string' || /[\/\\\x00-\x1f]/.test(body.sourceKey) || !/\.(xlsx|xls|csv)$/i.test(body.sourceKey))) throw new Error('INVALID_FILE');
      if (!body.sourceKey && (typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest))) throw new Error('INVALID_FILE');
      input.newFileId = crypto.randomUUID();
      input.sourceBucket = body.sourceKey ? 'excel-files' : 'profile-workbooks';
      input.sourcePath = body.sourceKey || `${input.newFileId}.${body.name.split('.').pop().toLowerCase()}`;
      if (body.sourceKey) await signed(input.sourceBucket, input.sourcePath);
    }
    if (body.action === 'import-finish') {
      const file = unwrap(await db.from('cd_data_files').select('source_bucket,source_path,owner_id').eq('id', body.fileId).maybeSingle());
      if (!file || file.owner_id !== actor.id) throw new Error('INVALID_IMPORT');
      await signed(file.source_bucket, file.source_path);
    }
    const result = unwrap(await db.rpc('cd_data_call', {
      p_actor: actor.id, p_username: actor.email.split('@')[0], p_request: mutating ? body.requestId : null, p_hash: hash, p: input
    }));
    if (result.sourceBucket) {
      if (body.action === 'import-start' && !body.sourceKey && !result.ready) {
        // A signed ticket permits only a new immutable object, never overwriting one.
        const existing = await db.storage.from(result.sourceBucket).createSignedUrl(result.sourcePath, 600);
        if (existing.data?.signedUrl) result.url = existing.data.signedUrl;
        else {
          const upload = unwrap(await db.storage.from(result.sourceBucket).createSignedUploadUrl(result.sourcePath, { upsert: false }));
          result.upload = { bucket: result.sourceBucket, path: result.sourcePath, token: upload.token };
        }
      } else if (!result.ready || body.action === 'export-source') result.url = await signed(result.sourceBucket, result.sourcePath);
      delete result.sourceBucket; delete result.sourcePath;
    }
    return result;
  };
}
