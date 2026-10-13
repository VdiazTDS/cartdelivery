begin;
create table public.cd_admin_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null,
  actor_id uuid,
  target_id uuid not null,
  action text not null,
  details jsonb not null,
  created_at timestamptz not null default now(),
  unique(operation_id, action)
);
alter table public.cd_admin_events enable row level security;
revoke all on public.cd_admin_events from public, anon, authenticated;
grant all on public.cd_admin_events to service_role;
grant usage on sequence public.cd_admin_events_id_seq to service_role;

create function public.cd_admin_directory(p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from auth.users where id=p_actor and raw_app_meta_data->>'cartdelivery_admin'='true'
    and coalesce(raw_app_meta_data->>'cartdelivery_disabled','false')<>'true' and deleted_at is null
    and (banned_until is null or banned_until<now())) then raise exception 'ADMIN_REQUIRED'; end if;
  return jsonb_build_object('profiles',coalesce((select jsonb_agg(jsonb_build_object(
    'id',u.id,'username',split_part(u.email,'@',1),'createdAt',u.created_at,'lastSignInAt',u.last_sign_in_at,
    'isAdmin',coalesce(u.raw_app_meta_data->>'cartdelivery_admin','false')='true',
    'disabled',coalesce(u.raw_app_meta_data->>'cartdelivery_disabled','false')='true' or coalesce(u.banned_until>now(),false),
    'copies',(select count(*) from public.cd_data_copies c where c.owner_id=u.id),
    'pending',(select coalesce(sum(c.pending_count),0) from public.cd_data_copies c where c.owner_id=u.id),
    'areas',(select count(*) from public.cd_work_areas w cross join lateral jsonb_array_elements(w.areas) a where a->>'profileId'=u.id::text)
  ) order by u.email) from auth.users u where u.deleted_at is null and u.email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$'),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(e order by e.created_at desc,e.id desc) from
    (select id,action,details,created_at from public.cd_admin_events order by created_at desc,id desc limit 30) e),'[]'::jsonb));
end;
$$;
revoke all on function public.cd_admin_directory(uuid) from public,anon,authenticated;
grant execute on function public.cd_admin_directory(uuid) to service_role;

create function public.cd_auth_profile_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_name text; new_name text; event jsonb; event_action text; removed boolean;
begin
  if tg_op='UPDATE' then old_name:=split_part(old.email,'@',1); end if;
  if not coalesce(new.email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$',false) and
    (tg_op='INSERT' or not coalesce(old.email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$',false)) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('cd_profile_directory',4));
  removed:=new.deleted_at is not null or new.email is null or new.email !~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$';
  if removed and exists(select 1 from public.cd_work_areas w cross join lateral jsonb_array_elements(w.areas) a where a->>'profileId'=new.id::text)
    then raise exception 'PROFILE_HAS_AREAS'; end if;
  new_name:=case when removed then 'removed-'||new.id::text else split_part(new.email,'@',1) end;
  insert into public.cd_profiles(user_id,display_name) values(new.id,new_name)
    on conflict(user_id) do update set display_name=excluded.display_name;
  if not removed and old_name is distinct from new_name then
    update public.cd_work_areas w set areas=(select jsonb_agg(case when a->>'profileId'=new.id::text then jsonb_set(a,'{profileName}',to_jsonb(new_name)) else a end order by ord)
      from jsonb_array_elements(w.areas) with ordinality as items(a,ord)), revision=revision+1,updated_at=now()
      where exists(select 1 from jsonb_array_elements(w.areas) a where a->>'profileId'=new.id::text);
  end if;
  event:=new.raw_app_meta_data->'cartdelivery_admin_event';
  if removed then event:=old.raw_app_meta_data->'cartdelivery_admin_event'; end if;
  if event is not null and (tg_op='INSERT' or removed or event is distinct from old.raw_app_meta_data->'cartdelivery_admin_event') then
    event_action:=case when removed then 'removed' when tg_op='INSERT' then 'created'
      when event->>'action'='admin-status' then case when new.raw_app_meta_data->>'cartdelivery_disabled'='true' then 'disabled' else 'enabled' end
      when event->>'action'='admin-remove' then 'removal-started' else 'updated' end;
    insert into public.cd_admin_events(operation_id,actor_id,target_id,action,details)
      values((event->>'id')::uuid,(event->>'actor')::uuid,new.id,event_action,jsonb_build_object('username',case when removed then old_name else new_name end,
        'previousUsername',old_name,'passwordChanged',case when tg_op='INSERT' then true else old.encrypted_password is distinct from new.encrypted_password end))
      on conflict(operation_id,action) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.cd_auth_profile_changed() from public,anon,authenticated;
create trigger cd_auth_profile_changed after insert or update of email,deleted_at,raw_app_meta_data,encrypted_password on auth.users
  for each row execute function public.cd_auth_profile_changed();

-- Serialize directory changes with area assignments so removed accounts cannot receive new areas.
alter function public.cd_work_areas_call(uuid,text,uuid,text,jsonb) rename to cd_work_areas_before_admin;
create function public.cd_work_areas_call(p_actor uuid,p_username text,p_request uuid,p_hash text,p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('cd_profile_directory',4));
  return public.cd_work_areas_before_admin(p_actor,p_username,p_request,p_hash,p);
end;
$$;
revoke all on function public.cd_work_areas_call(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.cd_work_areas_call(uuid,text,uuid,text,jsonb) to service_role;
commit;
