const assert = require('node:assert/strict'), fs = require('node:fs');
const { fixture } = require('./load-profiles.fixture.cjs');
(async () => {
  const fx = fixture(), { createAdminService } = await import('../supabase/functions/profile-workbooks/admin-service.mjs');
  const handle = createAdminService(fx.db), call = (action, body = {}) => handle({ action, ...body }, fx.admin);
  for (const action of ['admin-load-list', 'admin-load-create', 'admin-load-delete']) {
    for (const actor of [null, { app_metadata: {}, user_metadata: { cartdelivery_admin: true } }, { ...fx.admin, app_metadata: { cartdelivery_admin: true, cartdelivery_disabled: true } }]) {
      await assert.rejects(() => handle({ action }, actor), /ADMIN_REQUIRED/);
    }
  }
  for (const name of ['Vicente', 'Daniel', 'Mike', 'Camden', 'Justin']) await call('admin-load-create', { name });
  assert.equal((await call('admin-load-list')).profiles.length, 5);
  const { profile } = await call('admin-load-create', { name: '  VICENTE  ' });
  assert.equal(profile.name, 'Vicente'); assert.equal(fx.objects.size, 5);
  for (let i = 0; i < 401; i++) fx.objects.set(`_cart-loads/load-${String(i).padStart(5, '0')}.json`, '{}');
  assert.equal((await call('admin-load-list')).profiles.length, 5, 'List paginates past loads');
  const request = { profileId: profile.id, confirmName: profile.name };
  await assert.rejects(() => call('admin-load-delete', { ...request, confirmName: 'wrong' }), /INVALID_LOAD_CONFIRMATION/);
  await assert.rejects(() => call('admin-load-delete', { ...request, profileId: '../profile' }), /INVALID_LOAD_PROFILE/);
  fx.state.failWrite = true;
  await assert.rejects(() => call('admin-load-delete', request));
  assert.equal((await call('admin-load-list')).profiles.length, 5);
  fx.state.failWrite = false; fx.state.loseResponse = true;
  await call('admin-load-delete', request); await call('admin-load-delete', request);
  assert.equal((await call('admin-load-list')).profiles.length, 4);
  assert.equal(fx.objects.size, 407, 'Only a deletion marker is added; history stays intact');
  await assert.rejects(() => call('admin-load-create', { name: 'Vicente' }), /INVALID_DELETED_LOAD_PROFILE/);
  fx.state.failRead = true; await assert.rejects(() => call('admin-load-list'));
  const { fixture: pgFixture } = require('./profile-data.fixture.cjs'), pgfx = await pgFixture();
  try {
    await pgfx.pg.exec(fs.readFileSync('supabase/migrations/202610140002_load_profile_admin.sql', 'utf8'));
    for (const role of ['anon', 'authenticated']) {
      await pgfx.pg.exec(`set role ${role}`);
      await pgfx.pg.query("insert into storage.objects(bucket_id,name) values('excel-files','_cart-loads/profile-test.json')");
      await assert.rejects(() => pgfx.pg.query("insert into storage.objects(bucket_id,name) values('excel-files','_cart-loads/deleted-test.json')"), /row-level security/);
      const removed = await pgfx.pg.query("delete from storage.objects where name='_cart-loads/profile-test.json' returning name");
      assert.equal(removed.rows.length, 0);
      const changed = await pgfx.pg.query("update storage.objects set name='_cart-loads/deleted-test.json' where name='_cart-loads/profile-test.json' returning name");
      assert.equal(changed.rows.length, 0);
      await pgfx.pg.exec('reset role');
    }
  } finally { await pgfx.pg.close(); }
  console.log('PASS: load profile admin authorization, five names, deduplication, pagination, failed writes, retries, preserved history, deletion protection and Storage RLS.');
})().catch(error => { console.error(error); process.exitCode = 1; });
