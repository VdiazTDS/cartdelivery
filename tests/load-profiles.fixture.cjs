const { randomUUID } = require('node:crypto');
function fixture() {
  const objects = new Map(), state = { failWrite: false, loseResponse: false, failRead: false, delayWrite: null };
  const admin = { id: randomUUID(), email: 'admin@profiles.cartdelivery.invalid', app_metadata: { cartdelivery_admin: true } };
  const driver = {id:randomUUID(),email:'vicente@profiles.cartdelivery.invalid',app_metadata:{}};
  const other = {id:randomUUID(),email:'daniel@profiles.cartdelivery.invalid',app_metadata:{}};
  const users = [admin,driver,other], owners = new Map();
  const bucket = {
    list: async (prefix, { offset = 0, limit = 200, search = '' } = {}) => state.failRead ? { error: Error('Read failed') } :
      { data: [...objects.keys()].filter(name => name.startsWith(prefix + '/') && name.slice(prefix.length + 1).includes(search)).sort().slice(offset, offset + limit).map(name => ({ name: name.slice(prefix.length + 1) })) },
    download: async name => state.failRead || !objects.has(name) ? { error: Error('Read failed') } : { data: new Blob([objects.get(name)]) },
    upload: async (name, bytes, options) => {
      if (state.delayWrite) await state.delayWrite;
      if (state.failWrite || (objects.has(name) && !options.upsert)) return { error: Error('Write failed') };
      objects.set(name, typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString());
      return state.loseResponse ? { error: Error('Response lost') } : { data: { path: name } };
    }
  };
  const db = { storage: { from: () => bucket }, rpc: async (name,args) => {
    const actor = users.find(user => user.id === args.p_actor);
    if (!actor || actor.app_metadata.cartdelivery_disabled) return {error:Error('SIGN_IN_REQUIRED')};
    if (name === 'cd_load_permissions') return {data:{userId:actor.id,profileIds:[...owners].filter(([,owner])=>owner===actor.id).map(([id])=>id)}};
    if (!actor.app_metadata.cartdelivery_admin) return {error:Error('ADMIN_REQUIRED')};
    if (name === 'cd_load_owners') {
      if (args.p_assign) {
        if (args.p_owner && !users.some(user=>user.id===args.p_owner && !user.app_metadata.cartdelivery_disabled)) return {error:Error('INVALID_LOAD_OWNER')};
        owners.set(args.p_profile,args.p_owner);
      }
      return {data:[...owners].map(([profileId,ownerId])=>({profileId,ownerId}))};
    }
    return {data:{profiles:users.map(user=>({id:user.id,username:user.email.split('@')[0],isAdmin:!!user.app_metadata.cartdelivery_admin,disabled:false,copies:0,pending:0,areas:0})),events:[]}};
  } };
  return { objects, state, admin, driver, other, users, owners, bucket, db };
}
module.exports = { fixture };
