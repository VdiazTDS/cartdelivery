const alias = /^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$/;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const isProfileAdmin = user => user?.app_metadata?.cartdelivery_admin === true && !user.app_metadata.cartdelivery_disabled;
export const profileDisabled = user => user?.app_metadata?.cartdelivery_disabled === true || Boolean(user?.deleted_at) || Date.parse(user?.banned_until || '') > Date.now();
export function createAdminService(db) {
  const unwrap = result => { if (result.error) throw result.error; return result.data; };
  return async (body, actor) => {
    if (!isProfileAdmin(actor) || profileDisabled(actor)) throw new Error('ADMIN_REQUIRED');
    if (body.action === 'admin-list') return unwrap(await db.rpc('cd_admin_directory', { p_actor: actor.id }));
    if (!['admin-save','admin-status','admin-remove'].includes(body.action)) throw new Error('INVALID_ADMIN_ACTION');
    const creating = body.action === 'admin-save' && !body.userId;
    if (!creating && !uuid(body.userId)) throw new Error('INVALID_PROFILE');
    const target = creating ? null : unwrap(await db.auth.admin.getUserById(body.userId)).user;
    if (target && (!alias.test(target.email || '') || target.deleted_at)) throw new Error('INVALID_PROFILE');
    if (!creating && !target) throw new Error('INVALID_PROFILE');
    const metadata = { ...target?.app_metadata, cartdelivery_admin_event: { id: crypto.randomUUID(), actor: actor.id, action: body.action } };
    if (body.action === 'admin-save') {
      const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(username)) throw new Error('INVALID_USERNAME');
      if (creating && username === 'admin') throw new Error('ADMIN_PROTECTED');
      const password = body.password;
      if (typeof password !== 'string' || ((creating || password.length) && [...password].length < 6)) throw new Error('INVALID_PASSWORD');
      if (target?.app_metadata?.cartdelivery_admin === true && (target.id !== actor.id || username !== target.email.split('@')[0])) throw new Error('ADMIN_PROTECTED');
      if (body.color !== undefined) {
        if (body.color !== null && (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color))) throw new Error('INVALID_PROFILE_COLOR');
        metadata.cartdelivery_color = body.color?.toLowerCase() || null;
      }
      const attributes = { email: `${username}@profiles.cartdelivery.invalid`, email_confirm: true, app_metadata: metadata, ...(password ? { password } : {}) };
      const result = creating ? await db.auth.admin.createUser(attributes) : await db.auth.admin.updateUserById(target.id, attributes);
      const user = unwrap(result).user;
      return { saved: true, userId: user.id };
    }
    if (target.app_metadata?.cartdelivery_admin === true || target.id === actor.id) throw new Error('ADMIN_PROTECTED');
    if (body.action === 'admin-status') {
      if (typeof body.disabled !== 'boolean') throw new Error('INVALID_PROFILE_STATUS');
      unwrap(await db.auth.admin.updateUserById(target.id, { ban_duration: body.disabled ? '876000h' : 'none', app_metadata: { ...metadata, cartdelivery_disabled: body.disabled } }));
      return { saved: true };
    }
    if (body.confirmUsername !== target.email.split('@')[0]) throw new Error('INVALID_REMOVE_CONFIRMATION');
    const directory = unwrap(await db.rpc('cd_admin_directory', { p_actor: actor.id }));
    if (directory.profiles.find(profile => profile.id === target.id)?.areas) throw new Error('PROFILE_HAS_AREAS');
    // Block existing sessions before removing the login; historical records remain linked.
    unwrap(await db.auth.admin.updateUserById(target.id, { ban_duration: '876000h', app_metadata: { ...metadata, cartdelivery_disabled: true } }));
    const removed = await db.auth.admin.deleteUser(target.id, true);
    if (removed.error) throw new Error('REMOVE_INCOMPLETE');
    return { removed: true };
  };
}
