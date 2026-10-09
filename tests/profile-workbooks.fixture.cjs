const { PGlite } = require('../local-artifacts/test-tools/node_modules/@electric-sql/pglite');
const XLSX = require('../local-artifacts/test-tools/node_modules/xlsx');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create schema storage; create table storage.buckets(id text primary key, name text, public boolean);
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant all on storage.objects to anon, authenticated;
    create policy legacy_allow_all on storage.objects for all to anon, authenticated using(true) with check(true);`);
  await pg.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/202610100001_profile_workbooks.sql'), 'utf8'));
  const objects = new Map();
  const state = { failUpload: false, failCommit: false, uploads: [], commits: [], beforeCommit: null };
  class Query {
    constructor(table) { this.table = table; this.fields = '*'; this.filters = []; this.orders = []; }
    select(fields) { this.fields = fields; return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    order(key, options = {}) { this.orders.push(`"${key}" ${options.ascending === false ? 'desc' : 'asc'}`); return this; }
    range(first, last) { this.first = first; this.last = last; return this; }
    maybeSingle() { this.single = true; return this; }
    upsert(value) { this.value = value; return this; }
    async run() {
      try {
        if (this.value) {
          const keys = Object.keys(this.value);
          await pg.query(`insert into public.${this.table} (${keys.map(k => `"${k}"`).join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})
            on conflict(user_id) do update set display_name=excluded.display_name`, Object.values(this.value));
          return { data: null, error: null };
        }
        const columns = this.fields === '*' ? '*' : this.fields.split(',').map(k => `"${k}"`).join(',');
        const result = await pg.query(`select ${columns} from public.${this.table}${this.filters.length ? ' where ' + this.filters.map(([key], i) => `"${key}"=$${i + 1}`).join(' and ') : ''}${this.orders.length ? ' order by ' + this.orders.join(',') : ''}${this.last !== undefined ? ` limit ${this.last - this.first + 1} offset ${this.first}` : ''}`, this.filters.map(([, value]) => value));
        return { data: this.single ? result.rows[0] || null : result.rows, error: null };
      } catch (error) { return { data: null, error }; }
    }
    then(resolve, reject) { return this.run().then(resolve, reject); }
  }
  const db = {
    from: table => new Query(table),
    rpc: async (_, args) => {
      try {
        if (state.beforeCommit) await state.beforeCommit(args);
        if (state.failCommit) throw new Error('Simulated commit failure');
        const result = await pg.query('select public.cd_commit($1,$2,$3,$4,$5) as result', [args.p_action, args.p_actor, args.p_request, args.p_hash, args.p]);
        state.commits.push(args);
        return { data: result.rows[0].result, error: null };
      } catch (error) { return { data: null, error }; }
    },
    storage: { from: bucket => ({
      download: async name => objects.has(`${bucket}/${name}`) ? { data: new Blob([objects.get(`${bucket}/${name}`)]) } : { error: new Error('Missing fixture object') },
      upload: async (name, bytes, options) => {
        if (state.failUpload) return { error: new Error('Simulated upload failure') };
        if (options.upsert !== false || objects.has(`${bucket}/${name}`)) throw new Error('Mutable object upload attempted');
        const copy = new Uint8Array(bytes); objects.set(`${bucket}/${name}`, copy); state.uploads.push(`${bucket}/${name}`); return { data: { path: name } };
      },
      createSignedUrl: async name => ({ data: { signedUrl: `https://fixture.invalid/${bucket}/${name}` } })
    }) }
  };
  const { createWorkbookService } = await import('../supabase/functions/profile-workbooks/service.mjs');
  const handle = createWorkbookService(db, XLSX);
  async function actor(name) {
    const user = { id: randomUUID(), email: `${name}@profiles.cartdelivery.invalid` };
    await pg.query('insert into auth.users(id) values($1)', [user.id]); return user;
  }
  const workbook = rows => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stops');
    XLSX.utils.book_append_sheet(wb, { A1: { t: 'n', v: 3, f: '1+2' }, '!ref': 'A1' }, 'Keep formula');
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  };
  const call = (who, action, fields = {}) => handle({ action, requestId: randomUUID(), ...fields }, who);
  return { pg, db, state, objects, actor, handle, call, workbook, XLSX };
}
module.exports = { fixture };
