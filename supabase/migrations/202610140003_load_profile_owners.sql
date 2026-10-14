begin;

create table public.cd_load_profile_owners (
  profile_id text primary key check (profile_id ~ '^[a-f0-9]{64}$'),
  owner_id uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.cd_load_profile_owners enable row level security;
revoke all on public.cd_load_profile_owners from public, anon, authenticated;
grant all on public.cd_load_profile_owners to service_role;

create function public.cd_load_permissions(p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users where id=p_actor and deleted_at is null
    and email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$'
    and coalesce(raw_app_meta_data->>'cartdelivery_disabled','false')<>'true'
    and (banned_until is null or banned_until<=now())) then raise exception 'SIGN_IN_REQUIRED'; end if;
  return jsonb_build_object('userId',p_actor,'profileIds',coalesce((select jsonb_agg(profile_id order by profile_id)
    from public.cd_load_profile_owners where owner_id=p_actor),'[]'::jsonb));
end;
$$;

create function public.cd_load_owners(p_actor uuid, p_profile text default null, p_owner uuid default null, p_assign boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users where id=p_actor and deleted_at is null
    and raw_app_meta_data->>'cartdelivery_admin'='true'
    and coalesce(raw_app_meta_data->>'cartdelivery_disabled','false')<>'true'
    and (banned_until is null or banned_until<=now())) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_assign then
    if p_profile is null or p_profile !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_LOAD_PROFILE'; end if;
    if p_owner is not null and not exists (select 1 from auth.users where id=p_owner and deleted_at is null
      and email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$'
      and coalesce(raw_app_meta_data->>'cartdelivery_disabled','false')<>'true'
      and (banned_until is null or banned_until<=now())) then raise exception 'INVALID_LOAD_OWNER'; end if;
    insert into public.cd_load_profile_owners(profile_id,owner_id,updated_by) values(p_profile,p_owner,p_actor)
    on conflict(profile_id) do update set owner_id=excluded.owner_id,updated_by=excluded.updated_by,updated_at=now();
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('profileId',profile_id,'ownerId',owner_id))
    from public.cd_load_profile_owners),'[]'::jsonb);
end;
$$;
revoke all on function public.cd_load_permissions(uuid) from public,anon,authenticated;
revoke all on function public.cd_load_owners(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.cd_load_permissions(uuid) to service_role;
grant execute on function public.cd_load_owners(uuid,text,uuid,boolean) to service_role;

-- Existing named truck profiles are associated once, using stable account IDs.
insert into public.cd_load_profile_owners(profile_id,owner_id)
select names.profile_id,u.id from (values
  ('vicente','8293e4c57c1440349e9c48c66bd52d7033e7d8ffcb8a1f59a11fb0477c0d0df4'),
  ('daniel','bd3dae5fb91f88a4f0978222dfd58f59a124257cb081486387cbae9df11fb879'),
  ('mike','64b4d0f47c93ce23d157e68a58767356283dc9b63c459d45d0e0e39b3a64b9b9'),
  ('camden','dc0cebabb843ed024cb5b0a6c5a00a9fb19f86efc25f570732252ae20def99c5'),
  ('justin','102cf10b5286bad9fcfe5e275ace3ddd7dcc23931fb0ca93dc223daf9877cabd')
) as names(username,profile_id) join auth.users u on u.email=names.username||'@profiles.cartdelivery.invalid'
where u.deleted_at is null;

-- Payload ownership cannot be enforced by Storage path checks. All writes use the Edge Function.
create policy cd_load_log_insert on storage.objects as restrictive for insert to anon,authenticated
with check (bucket_id<>'excel-files' or not starts_with(name,'_cart-loads/'));

commit;
