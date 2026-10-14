const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const profileId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function createLoadService(db) {
  const bucket = db.storage.from('excel-files');
  const unwrap = result => { if (result.error) throw result.error; return result.data; };
  const read = async name => JSON.parse(await unwrap(await bucket.download(`_cart-loads/${name}`)).text());
  return async (body, actor) => {
    if (!actor?.id) throw new Error('SIGN_IN_REQUIRED');
    const permissions = unwrap(await db.rpc('cd_load_permissions', {p_actor:actor.id}));
    if (body.action === 'load-permissions') return permissions;
    const input = body.event;
    if (body.action !== 'load-write' || !input || !['load','void'].includes(input.kind) || !uuid(input.id)) throw new Error('INVALID_LOAD_RECORD');
    let event, id;
    if (input.kind === 'load') {
      const quantity = value => Number.isInteger(value) && value >= 0 && value <= 100000;
      if (!profileId(input.profileId) || !['truck','trailer'].includes(input.vehicleType)
        || typeof input.vehicleName !== 'string' || input.vehicleName.length > 60
        || !quantity(input.trash) || !quantity(input.recycling) || typeof input.unloadedAt !== 'string'
        || !Number.isFinite(Date.parse(input.unloadedAt))) throw new Error('INVALID_LOAD_RECORD');
      id = input.profileId;
      event = {version:1,kind:'load',id:input.id,profileId:id,vehicleType:input.vehicleType,
        vehicleName:input.vehicleName.trim(),trash:input.trash,recycling:input.recycling,unloadedAt:new Date(input.unloadedAt).toISOString()};
    } else {
      const load = await read(`load-${input.id}.json`);
      if (load.kind !== 'load' || load.id !== input.id || !profileId(load.profileId)) throw new Error('INVALID_LOAD_RECORD');
      id = load.profileId;
      event = {version:1,kind:'void',id:input.id,profileId:id};
    }
    if (!permissions.profileIds.includes(id)) throw new Error('LOAD_OWNER_REQUIRED');
    const profile = await read(`profile-${id}.json`);
    if (profile.kind !== 'profile' || profile.id !== id) throw new Error('INVALID_LOAD_PROFILE');
    const deleted = unwrap(await bucket.list('_cart-loads', {search:`deleted-${id}.json`,limit:100,offset:0}));
    if (!Array.isArray(deleted)) throw new Error('INVALID_LOAD_DIRECTORY');
    if (deleted.some(file => file.name === `deleted-${id}.json`)) throw new Error('INVALID_DELETED_LOAD_PROFILE');
    const saved = {...event,createdAt:new Date().toISOString(),recordedBy:actor.id};
    const name = `${event.kind}-${event.id}.json`;
    const {error} = await bucket.upload(`_cart-loads/${name}`,new TextEncoder().encode(JSON.stringify(saved)),
      {upsert:false,contentType:'application/json',cacheControl:'0'});
    if (!error) return {event:saved};
    const existing = await read(name);
    if (!Object.entries(event).every(([key,value]) => existing[key] === value)
      || existing.recordedBy !== actor.id) throw new Error('INVALID_LOAD_RETRY');
    return {event:existing};
  };
}
