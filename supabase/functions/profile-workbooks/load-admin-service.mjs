const prefix = '_cart-loads';
const profileId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function createLoadAdminService(db) {
  const bucket = db.storage.from('excel-files');
  const owners = async (actor, profile = null, owner = null, assign = false) => {
    const {data,error} = await db.rpc('cd_load_owners', {p_actor:actor.id,p_profile:profile,p_owner:owner,p_assign:assign});
    if (error) throw error;
    return data;
  };
  const read = async name => {
    const { data, error } = await bucket.download(`${prefix}/${name}`);
    if (error) throw error;
    return JSON.parse(await data.text());
  };
  const write = async event => {
    const name = `${event.kind}-${event.id}.json`;
    const { error } = await bucket.upload(`${prefix}/${name}`, new TextEncoder().encode(JSON.stringify(event)),
      { upsert: false, contentType: 'application/json', cacheControl: '0' });
    if (error) {
      // Immutable IDs make retries safe after an upload response is lost.
      const existing = await read(name);
      if (existing.kind !== event.kind || existing.id !== event.id) throw error;
      return existing;
    }
    return event;
  };
  const list = async () => {
    const names = [];
    for (let offset = 0; ; offset += 200) {
      const { data, error } = await bucket.list(prefix, { limit: 200, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('INVALID_LOAD_DIRECTORY');
      names.push(...data.map(file => file.name));
      if (data.length < 200) break;
    }
    const deleted = new Set(names.filter(name => /^deleted-[a-f0-9]{64}\.json$/.test(name)).map(name => name.slice(8, -5)));
    const files = names.filter(name => /^profile-[a-f0-9]{64}\.json$/.test(name) && !deleted.has(name.slice(8, -5)));
    const profiles = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
      while (cursor < files.length) {
        const name = files[cursor++], profile = await read(name);
        if (profile.kind !== 'profile' || !profileId(profile.id) || name !== `profile-${profile.id}.json` || typeof profile.name !== 'string') throw new Error('INVALID_LOAD_PROFILE');
        profiles.push(profile);
      }
    }));
    return { profiles: profiles.sort((a,b) => a.name.localeCompare(b.name)), deleted };
  };
  return async (body, actor) => {
    if (body.action === 'admin-load-list') {
      const assignments = await owners(actor);
      return {profiles:(await list()).profiles.map(profile => ({...profile,ownerId:assignments.find(item => item.profileId === profile.id)?.ownerId || null}))};
    }
    if (body.action === 'admin-load-assign') {
      if (!profileId(body.profileId) || !(await list()).profiles.some(profile => profile.id === body.profileId)) throw new Error('INVALID_LOAD_PROFILE');
      await owners(actor,body.profileId,body.ownerId || null,true);
      return {saved:true};
    }
    if (body.action === 'admin-load-create') {
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 80) throw new Error('INVALID_LOAD_NAME');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.normalize('NFKC').toLowerCase()));
      const id = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if ((await list()).deleted.has(id)) throw new Error('INVALID_DELETED_LOAD_PROFILE');
      const profile = await write({ version: 1, kind: 'profile', id, name, createdAt: new Date().toISOString() });
      if (body.ownerId) await owners(actor,id,body.ownerId,true);
      return {profile};
    }
    if (body.action !== 'admin-load-delete' || !profileId(body.profileId)) throw new Error('INVALID_LOAD_PROFILE');
    const profile = await read(`profile-${body.profileId}.json`);
    if (profile.kind !== 'profile' || profile.id !== body.profileId || body.confirmName !== profile.name) throw new Error('INVALID_LOAD_CONFIRMATION');
    await write({ version: 1, kind: 'deleted', id: profile.id, name: profile.name, createdAt: new Date().toISOString(), actor: actor.id });
    return { deleted: true };
  };
}
