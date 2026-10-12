const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { fixture: workbookFixture } = require('./profile-workbooks.fixture.cjs');

async function fixture({ legacySeed } = {}) {
  const fx = await workbookFixture();
  const legacy = legacySeed ? await legacySeed(fx) : null;
  await fx.pg.exec(fs.readFileSync(require('node:path').join(__dirname, '../supabase/migrations/202610100002_database_deliveries.sql'), 'utf8'));
  await fx.pg.exec(fs.readFileSync(require('node:path').join(__dirname, '../supabase/migrations/202610120001_public_team_views.sql'), 'utf8'));
  await fx.pg.exec(fs.readFileSync(require('node:path').join(__dirname, '../supabase/migrations/202610120002_import_field_mapping.sql'), 'utf8'));
  await fx.pg.exec(fs.readFileSync(require('node:path').join(__dirname, '../supabase/migrations/202610120003_last_sync_time.sql'), 'utf8'));
  await fx.pg.exec(fs.readFileSync(require('node:path').join(__dirname, '../supabase/migrations/202610120004_profile_work_areas.sql'), 'utf8'));
  const db = { ...fx.db, rpc: async (name, args) => {
    try {
      if (name === 'cd_data_public_read') return { data: (await fx.pg.query('select public.cd_data_public_read($1) result', [args.p])).rows[0].result };
      if (!['cd_data_call', 'cd_data_import_mapped', 'cd_work_areas_call'].includes(name)) throw new Error('Unexpected RPC');
      if (fx.state.beforeCommit) await fx.state.beforeCommit(args);
      if (fx.state.failCommit) throw new Error('Simulated commit failure');
      const { rows } = await fx.pg.query(`select public.${name}($1,$2,$3,$4,$5) result`, [args.p_actor,args.p_username,args.p_request,args.p_hash,args.p]);
      fx.state.commits.push(args);
      return { data: rows[0].result };
    } catch (error) { return { error }; }
  }, storage: { from: bucket => ({
    ...fx.db.storage.from(bucket),
    createSignedUrl: async name => fx.objects.has(`${bucket}/${name}`) ? { data: { signedUrl: `https://fixture.invalid/${bucket}/${name}` } } : { error: new Error('Missing fixture object') },
    createSignedUploadUrl: async name => ({ data: { token: 'fixture-upload', path: name } })
  }) } };
  const { createDataService } = await import('../supabase/functions/profile-workbooks/data-service.mjs');
  const handle = createDataService(db);
  const call = (user, action, fields = {}) => handle({ action, requestId: randomUUID(), ...fields }, user);
  const read = async (user, fileId, mode = 'copy') => {
    const view = await call(user, mode === 'copy' ? 'open' : 'original', { fileId });
    const rows = [];
    while (rows.length < view.rowCount) {
      const page = await call(user, 'rows', { fileId, mode, offset: rows.length, copyRevision: view.copyRevision, masterRevision: view.masterRevision });
      rows.push(...page.rows);
    }
    return rows;
  };
  const importRows = async (user, name, rows) => {
    fx.objects.set('excel-files/' + name, fx.workbook(rows));
    const prepared = await call(user, 'import-start', { name, sourceKey: name });
    for (let offset = prepared.rowCount; offset < rows.length; offset += 250) {
      await call(user, 'import-batch', { fileId: prepared.fileId, offset, rows: rows.slice(offset, offset + 250) });
    }
    return call(user, 'import-finish', { fileId: prepared.fileId, rowCount: rows.length });
  };
  return { ...fx, db, handle, call, read, importRows, legacy };
}
module.exports = { fixture };
