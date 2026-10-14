import { createClient } from 'npm:@supabase/supabase-js@2';
import { createDataService, publicActions } from './data-service.mjs';
import { createAdminService, profileDisabled } from './admin-service.mjs';
import { createLoadService } from './load-service.mjs';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const handle = createDataService(db);
const handleAdmin = createAdminService(db);
const handleLoads = createLoadService(db);
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers });
  try {
    if (Number(req.headers.get('Content-Length')) > 16_000_000) throw new Error('INVALID_REQUEST_SIZE');
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_000_000) { await reader.cancel(); throw new Error('INVALID_REQUEST_SIZE'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    let actor = null;
    if (!publicActions.has(body?.action)) {
      const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      if (!token) throw new Error('SIGN_IN_REQUIRED');
      const { data, error } = await db.auth.getUser(token);
      if (error || !data.user) throw new Error('SIGN_IN_REQUIRED');
      actor = data.user;
      if (profileDisabled(actor)) throw new Error('PROFILE_DISABLED');
    }
    return new Response(JSON.stringify(await (body?.action?.startsWith('admin-') ? handleAdmin(body, actor)
      : body?.action?.startsWith('load-') ? handleLoads(body, actor) : handle(body, actor))), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'REQUEST_FAILED';
    const known = message.match(/\b(ADMIN_REQUIRED|ADMIN_PROTECTED|LOAD_OWNER_REQUIRED|PROFILE_DISABLED|PROFILE_HAS_AREAS|REMOVE_INCOMPLETE|SIGN_IN_REQUIRED|CLIENT_UPDATE_REQUIRED|STALE_VERSION|NAME_EXISTS|REQUEST_REUSED|UNRESOLVED_CONFLICT|INVALID_[A-Z_]+|FILE_DELETED|FILE_NOT_FOUND|COPY_NOT_FOUND|FILE_TOO_LARGE|DUPLICATE_HEADERS|ROW_STRUCTURE_CHANGED)\b/)?.[0]
      || (/already.*registered|already.*exists|duplicate key/i.test(message) ? 'NAME_EXISTS' : null);
    if (!known) console.error('Profile workbook request failed', message);
    return new Response(JSON.stringify({ error: known || 'REQUEST_FAILED' }), {
      status: known === 'SIGN_IN_REQUIRED' ? 401 : ['ADMIN_REQUIRED','LOAD_OWNER_REQUIRED','PROFILE_DISABLED'].includes(known || '') ? 403 : known === 'STALE_VERSION' ? 409 : 400, headers
    });
  }
});
