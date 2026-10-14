const assert = require('node:assert/strict'), fs = require('node:fs'), {randomUUID} = require('node:crypto');
const {fixture} = require('./profile-admin.fixture.cjs');
const {fixture: storageFixture} = require('./load-profiles.fixture.cjs');
(async () => {
  const fx = await fixture(), storage = storageFixture();
  try {
    const admin = (await fx.db.auth.admin.createUser({email:'admin@profiles.cartdelivery.invalid',password:'fake-password',app_metadata:{cartdelivery_admin:true}})).data.user;
    const a = await fx.actor('vicente'), b = await fx.actor('daniel');
    await fx.pg.exec(fs.readFileSync('supabase/migrations/202610140002_load_profile_admin.sql','utf8'));
    await fx.pg.exec(fs.readFileSync('supabase/migrations/202610140003_load_profile_owners.sql','utf8'));
    const db = {...storage.db,rpc:async(name,args)=>{
      try {
        const result = name === 'cd_load_permissions'
          ? await fx.pg.query('select cd_load_permissions($1) result',[args.p_actor])
          : await fx.pg.query('select cd_load_owners($1,$2,$3,$4) result',[args.p_actor,args.p_profile,args.p_owner,args.p_assign]);
        return {data:result.rows[0].result};
      } catch(error) {return {error};}
    }};
    const {createAdminService} = await import('../supabase/functions/profile-workbooks/admin-service.mjs');
    const {createLoadService} = await import('../supabase/functions/profile-workbooks/load-service.mjs');
    const manage = createAdminService(db), loads = createLoadService(db);
    const profile = (await manage({action:'admin-load-create',name:'Vicente'},admin)).profile;
    const other = (await manage({action:'admin-load-create',name:'Daniel'},admin)).profile;
    assert.deepEqual((await loads({action:'load-permissions'},a)).profileIds,[profile.id]);
    assert.deepEqual((await loads({action:'load-permissions'},b)).profileIds,[other.id]);
    const event = {version:1,kind:'load',id:randomUUID(),profileId:profile.id,vehicleType:'truck',vehicleName:'Test',trash:0,recycling:0,unloadedAt:'2026-10-14T12:00:00Z',createdAt:'2000-01-01T00:00:00Z',recordedBy:b.id};
    const save = (who,input=event)=>loads({action:'load-write',event:input},who);
    await assert.rejects(()=>save(null),/SIGN_IN_REQUIRED/);
    await assert.rejects(()=>save(b),/LOAD_OWNER_REQUIRED/);
    await assert.rejects(()=>save(admin),/LOAD_OWNER_REQUIRED/);
    await assert.rejects(()=>manage({action:'admin-load-assign',profileId:profile.id,ownerId:b.id},a),/ADMIN_REQUIRED/);
    for (const trash of [-1,0.5,100001,'0',null]) await assert.rejects(()=>save(a,{...event,trash}),/INVALID_LOAD_RECORD/);
    await assert.rejects(()=>save(a,{...event,kind:'profile'}),/INVALID_LOAD_RECORD/);
    storage.state.failWrite=true; await assert.rejects(()=>save(a)); assert.equal(storage.objects.size,2);
    storage.state.failWrite=false;storage.state.loseResponse=true;
    const first = (await save(a)).event;
    assert.equal(first.recordedBy,a.id);assert.notEqual(first.createdAt,event.createdAt);
    assert.deepEqual((await save(a)).event,first);assert.equal(storage.objects.size,3);
    await assert.rejects(()=>save(a,{...event,trash:5}),/INVALID_LOAD_RETRY/);
    storage.state.loseResponse=false;
    const voidEvent={kind:'void',id:event.id,profileId:other.id};
    await assert.rejects(()=>save(b,voidEvent),/LOAD_OWNER_REQUIRED/);
    const voided=(await save(a,voidEvent)).event;
    assert.equal(voided.profileId,profile.id);assert.equal(voided.recordedBy,a.id);
    assert.deepEqual(JSON.parse(storage.objects.get(`_cart-loads/load-${event.id}.json`)),first,'Void preserves original');
    await manage({action:'admin-load-assign',profileId:profile.id,ownerId:b.id},admin);
    await assert.rejects(()=>save(a,{...event,id:randomUUID()}),/LOAD_OWNER_REQUIRED/);
    await save(b,{...event,id:randomUUID()});
    await fx.pg.query("update auth.users set email='renamed@profiles.cartdelivery.invalid' where id=$1",[b.id]);
    assert((await loads({action:'load-permissions'},b)).profileIds.includes(profile.id),'Rename preserves ID-based association');
    await fx.pg.query("update auth.users set raw_app_meta_data='{" + '"cartdelivery_disabled":true' + "}' where id=$1",[b.id]);
    await assert.rejects(()=>save(b,{...event,id:randomUUID()}),/SIGN_IN_REQUIRED/);
    await assert.rejects(()=>manage({action:'admin-load-assign',profileId:profile.id,ownerId:b.id},admin),/INVALID_LOAD_OWNER/);
    await manage({action:'admin-load-assign',profileId:profile.id,ownerId:null},admin);
    await assert.rejects(()=>save(a,{...event,id:randomUUID()}),/LOAD_OWNER_REQUIRED/);
    await manage({action:'admin-load-assign',profileId:profile.id,ownerId:a.id},admin);
    await manage({action:'admin-load-delete',profileId:profile.id,confirmName:'Vicente'},admin);
    await assert.rejects(()=>save(a,{...event,id:randomUUID()}),/INVALID_DELETED_LOAD_PROFILE/);
    for (const role of ['anon','authenticated']) {
      await fx.pg.exec(`set role ${role}`);
      for (const name of ['load-test.json','void-test.json','profile-test.json','deleted-test.json']) {
        await assert.rejects(()=>fx.pg.query("insert into storage.objects(bucket_id,name) values('excel-files',$1)",['_cart-loads/'+name]),/row-level security/);
      }
      await assert.rejects(()=>fx.pg.query('select * from cd_load_profile_owners'),/permission denied/);
      await assert.rejects(()=>fx.pg.query('select cd_load_permissions($1)',[a.id]),/permission denied/);
      await assert.rejects(()=>fx.pg.query('select cd_load_owners($1,$2,$3,true)',[admin.id,profile.id,a.id]),/permission denied/);
      await fx.pg.exec('reset role');
    }
    console.log('PASS: seeded ownership, cross-account denial, forged void targets/actors, validation, retry integrity, preserved history, rename, reassignment, disable, deletion and direct Storage/RPC restrictions.');
  } finally {await fx.pg.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
