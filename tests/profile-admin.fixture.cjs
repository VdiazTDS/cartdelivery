const { fixture: dataFixture } = require('./profile-data.fixture.cjs');
const { randomUUID,createHash } = require('node:crypto');
async function fixture() {
  const fx = await dataFixture();
  await fx.pg.exec('create unique index fixture_auth_email on auth.users(email);');
  const hash = password => createHash('sha256').update(password).digest('hex');
  const user = async id => {
    const row=(await fx.pg.query('select * from auth.users where id=$1',[id])).rows[0];
    return row ? {id:row.id,email:row.email,app_metadata:row.raw_app_meta_data,user_metadata:row.raw_user_meta_data,deleted_at:row.deleted_at,banned_until:row.banned_until} : null;
  };
  const attempt = async fn => {try{return {data:await fn()};}catch(error){return {error};}};
  const auth = {admin:{
    getUserById:id=>attempt(async()=>({user:await user(id)})),
    createUser:attributes=>attempt(async()=>{
      const id=randomUUID();
      await fx.pg.query('insert into auth.users(id,email,encrypted_password,raw_app_meta_data) values($1,$2,$3,$4)',[id,attributes.email,hash(attributes.password),attributes.app_metadata || {}]);
      return {user:await user(id)};
    }),
    updateUserById:(id,attributes)=>attempt(async()=>{
      if(fx.state.failAdminUpdate) throw Error('Simulated auth update failure');
      const values={};
      if(attributes.email!==undefined) values.email=attributes.email;
      if(attributes.app_metadata!==undefined) values.raw_app_meta_data=attributes.app_metadata;
      if(attributes.password!==undefined) values.encrypted_password=hash(attributes.password);
      if(attributes.ban_duration!==undefined) values.banned_until=attributes.ban_duration==='none'?null:'2126-01-01T00:00:00Z';
      const keys=Object.keys(values);
      await fx.pg.query(`update auth.users set ${keys.map((key,i)=>`${key}=$${i+2}`).join(',')} where id=$1`,[id,...Object.values(values)]);
      return {user:await user(id)};
    }),
    deleteUser:(id,soft)=>attempt(async()=>{
      if(!soft) throw Error('Only soft removal permitted');
      if(fx.state.failAdminDelete) throw Error('Simulated auth delete failure');
      await fx.pg.query("update auth.users set email=null,deleted_at=now(),encrypted_password='',raw_app_meta_data='{}' where id=$1",[id]);
      return {user:await user(id)};
    })
  }};
  const db={...fx.db,auth,rpc:async(name,args)=>name==='cd_admin_directory'?attempt(async()=>(await fx.pg.query('select public.cd_admin_directory($1) result',[args.p_actor])).rows[0].result):fx.db.rpc(name,args)};
  const {createAdminService,profileDisabled}=await import('../supabase/functions/profile-workbooks/admin-service.mjs');
  const adminHandle=createAdminService(db);
  const dispatch=async(body,actor)=>{
    if(!body.action?.startsWith('public-')) {
      actor=actor ? await user(actor.id) : null;
      if(!actor || actor.deleted_at) throw Error('SIGN_IN_REQUIRED');
      if(profileDisabled(actor)) throw Error('PROFILE_DISABLED');
    }
    return body.action.startsWith('admin-')?adminHandle(body,actor):fx.handle(body,actor);
  };
  return {...fx,db,user,hash,adminHandle,dispatch};
}
module.exports={fixture};
