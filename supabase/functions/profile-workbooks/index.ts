import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';
import { createWorkbookService } from './service.mjs';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const handle = createWorkbookService(db, XLSX);
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers });
  try {
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('SIGN_IN_REQUIRED');
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) throw new Error('SIGN_IN_REQUIRED');
    if (Number(req.headers.get('Content-Length')) > 29_000_000) throw new Error('FILE_TOO_LARGE');
    return new Response(JSON.stringify(await handle(await req.json(), data.user)), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'REQUEST_FAILED';
    const known = message.match(/\b(SIGN_IN_REQUIRED|STALE_VERSION|NAME_EXISTS|REQUEST_REUSED|UNRESOLVED_CONFLICT|INVALID_[A-Z_]+|FILE_NOT_FOUND|COPY_NOT_FOUND|FILE_TOO_LARGE|DUPLICATE_HEADERS|ROW_STRUCTURE_CHANGED)\b/)?.[0];
    if (!known) console.error('Profile workbook request failed', message);
    return new Response(JSON.stringify({ error: known || 'REQUEST_FAILED' }), {
      status: known === 'SIGN_IN_REQUIRED' ? 401 : known === 'STALE_VERSION' ? 409 : 400, headers
    });
  }
});
