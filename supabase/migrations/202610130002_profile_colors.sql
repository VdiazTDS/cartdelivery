begin;

alter function public.cd_admin_directory(uuid) rename to cd_admin_directory_before_colors;
create function public.cd_admin_directory(p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  result:=public.cd_admin_directory_before_colors(p_actor);
  return jsonb_set(result,'{profiles}',coalesce((select jsonb_agg(profile || jsonb_build_object(
    'color',u.raw_app_meta_data->>'cartdelivery_color') order by ord)
    from jsonb_array_elements(result->'profiles') with ordinality as items(profile,ord)
    join auth.users u on u.id::text=profile->>'id'),'[]'::jsonb));
end;
$$;
revoke all on function public.cd_admin_directory(uuid) from public,anon,authenticated;
grant execute on function public.cd_admin_directory(uuid) to service_role;

create function public.cd_auth_profile_color_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare color text:=new.raw_app_meta_data->>'cartdelivery_color';
begin
  if new.email !~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$' or new.deleted_at is not null then return new; end if;
  if color is not null and color !~ '^#[0-9a-fA-F]{6}$' then raise exception 'INVALID_PROFILE_COLOR'; end if;
  if color is null or (tg_op='UPDATE' and color is not distinct from old.raw_app_meta_data->>'cartdelivery_color') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('cd_profile_directory',4));
  update public.cd_work_areas w set areas=(select jsonb_agg(case when a->>'profileId'=new.id::text
    then jsonb_set(a,'{color}',to_jsonb(color)) else a end order by ord)
    from jsonb_array_elements(w.areas) with ordinality as items(a,ord)),revision=revision+1,updated_at=now()
    where exists(select 1 from jsonb_array_elements(w.areas) a where a->>'profileId'=new.id::text and a->>'color' is distinct from color);
  return new;
end;
$$;
revoke all on function public.cd_auth_profile_color_changed() from public,anon,authenticated;
create trigger cd_auth_profile_color_changed after insert or update of raw_app_meta_data on auth.users
  for each row execute function public.cd_auth_profile_color_changed();

create or replace function public.cd_work_areas_call(p_actor uuid,p_username text,p_request uuid,p_hash text,p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('cd_profile_directory',4));
  if p->>'action'='work-areas-save' and jsonb_typeof(p->'areas')='array' then
    p:=jsonb_set(p,'{areas}',coalesce((select jsonb_agg(case when
      u.raw_app_meta_data->>'cartdelivery_color' ~ '^#[0-9a-fA-F]{6}$'
      then jsonb_set(a,'{color}',u.raw_app_meta_data->'cartdelivery_color') else a end order by ord)
      from jsonb_array_elements(p->'areas') with ordinality as items(a,ord)
      left join auth.users u on u.id::text=lower(a->>'profileId')),'[]'::jsonb));
  end if;
  result:=public.cd_work_areas_before_admin(p_actor,p_username,p_request,p_hash,p);
  return jsonb_set(result,'{profiles}',coalesce((select jsonb_agg(profile || jsonb_build_object(
    'color',u.raw_app_meta_data->>'cartdelivery_color') order by ord)
    from jsonb_array_elements(result->'profiles') with ordinality as items(profile,ord)
    join auth.users u on u.id::text=profile->>'id'),'[]'::jsonb));
end;
$$;
commit;
