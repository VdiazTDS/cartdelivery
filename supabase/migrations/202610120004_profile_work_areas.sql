begin;

create table public.cd_work_areas (
  file_id uuid primary key references public.cd_data_files(id),
  revision bigint not null default 0,
  areas jsonb not null default '[]'::jsonb,
  updated_by uuid references public.cd_profiles(user_id),
  updated_at timestamptz
);
alter table public.cd_work_areas enable row level security;
revoke all on public.cd_work_areas from public, anon, authenticated;
grant all on public.cd_work_areas to service_role;

create function public.cd_work_areas_call(p_actor uuid, p_username text, p_request uuid, p_hash text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  fid uuid := (p->>'fileId')::uuid;
  snapshot public.cd_work_areas;
  receipt public.cd_data_receipts;
  result jsonb; profiles jsonb; clean jsonb := '[]'::jsonb;
  area jsonb; ring jsonb; point jsonb; first_point jsonb; previous_point jsonb;
  ids text[] := array[]::text[]; profile_name text;
  lon numeric; lat numeric; signed_area numeric; vertices integer := 0;
begin
  if p_actor is null or p_username is null or not exists (
    select 1 from auth.users where id=p_actor and email=p_username||'@profiles.cartdelivery.invalid'
      and email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$'
  ) then raise exception 'SIGN_IN_REQUIRED'; end if;
  if p->>'action' not in ('work-areas','work-areas-save') or p->>'action' is null then raise exception 'INVALID_WORK_AREA_ACTION'; end if;
  if not exists(select 1 from public.cd_data_files where id=fid and ready) then raise exception 'FILE_NOT_FOUND'; end if;
  insert into public.cd_profiles(user_id,display_name) values(p_actor,p_username)
    on conflict(user_id) do update set display_name=excluded.display_name;

  if p->>'action'='work-areas-save' then
    if p->>'mode' is distinct from 'original' then raise exception 'INVALID_WORK_AREA_VIEW'; end if;
    if p_request is null or p_hash is null then raise exception 'INVALID_REQUEST_ID'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_actor::text||p_request::text,2));
    select * into receipt from public.cd_data_receipts where actor_id=p_actor and request_id=p_request;
    if found then
      if receipt.request_hash<>p_hash then raise exception 'REQUEST_REUSED'; end if;
      return receipt.result;
    end if;
    if jsonb_typeof(p->'revision') is distinct from 'number' or (p->>'revision') !~ '^[0-9]+$'
      or jsonb_typeof(p->'areas') is distinct from 'array' then raise exception 'INVALID_WORK_AREAS'; end if;
    if jsonb_array_length(p->'areas')>100 or octet_length((p->'areas')::text)>2000000 then raise exception 'INVALID_WORK_AREAS'; end if;
    for area in select value from jsonb_array_elements(p->'areas') loop
      if jsonb_typeof(area) is distinct from 'object'
        or coalesce(area->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or lower(area->>'id')=any(ids)
        or jsonb_typeof(area->'name') is distinct from 'string' or length(trim(area->>'name')) not between 1 and 80
        or coalesce(area->>'color','') !~ '^#[0-9a-fA-F]{6}$'
        or coalesce(area->>'profileId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then raise exception 'INVALID_WORK_AREA'; end if;
      ids := array_append(ids,lower(area->>'id'));
      select split_part(email,'@',1) into profile_name from auth.users
        where id=(area->>'profileId')::uuid and email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$';
      if profile_name is null then raise exception 'INVALID_WORK_AREA_PROFILE'; end if;
      if area->'geometry'->>'type' is distinct from 'Polygon'
        or jsonb_typeof(area->'geometry'->'coordinates') is distinct from 'array' then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
      if jsonb_array_length(area->'geometry'->'coordinates')<>1 then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
      ring := area->'geometry'->'coordinates'->0;
      if jsonb_typeof(ring) is distinct from 'array' then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
      if jsonb_array_length(ring) not between 4 and 501 or ring->0 is distinct from ring->(jsonb_array_length(ring)-1)
        then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
      vertices := vertices + jsonb_array_length(ring);
      if vertices>10000 then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
      signed_area := 0; previous_point := null; first_point := ring->0;
      for point in select value from jsonb_array_elements(ring) loop
        if jsonb_typeof(point) is distinct from 'array' then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
        if jsonb_array_length(point)<>2 or jsonb_typeof(point->0) is distinct from 'number' or jsonb_typeof(point->1) is distinct from 'number'
          then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
        lon := (point->>0)::numeric; lat := (point->>1)::numeric;
        if lon not between -180 and 180 or lat not between -90 and 90 then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
        if previous_point is not null then
          signed_area := signed_area + ((previous_point->>0)::numeric-(first_point->>0)::numeric)*(lat-(first_point->>1)::numeric)
            - (lon-(first_point->>0)::numeric)*((previous_point->>1)::numeric-(first_point->>1)::numeric);
        end if;
        previous_point := point;
      end loop;
      if signed_area=0 then raise exception 'INVALID_WORK_AREA_GEOMETRY'; end if;
      clean := clean || jsonb_build_array(jsonb_build_object('id',lower(area->>'id'),'name',trim(area->>'name'),
        'profileId',lower(area->>'profileId'),'profileName',profile_name,'color',area->>'color','geometry',area->'geometry'));
    end loop;
    insert into public.cd_work_areas(file_id) values(fid) on conflict do nothing;
    select * into snapshot from public.cd_work_areas where file_id=fid for update;
    if snapshot.revision<>(p->>'revision')::bigint then raise exception 'STALE_VERSION'; end if;
    update public.cd_work_areas set areas=clean,revision=revision+1,updated_by=p_actor,updated_at=now()
      where file_id=fid returning * into snapshot;
  else
    select * into snapshot from public.cd_work_areas where file_id=fid;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',split_part(email,'@',1)) order by email),'[]'::jsonb)
    into profiles from auth.users where email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$';
  result := jsonb_build_object('fileId',fid,'revision',coalesce(snapshot.revision,0),'areas',coalesce(snapshot.areas,'[]'::jsonb),
    'profiles',profiles,'updatedAt',snapshot.updated_at);
  if p->>'action'='work-areas-save' then
    insert into public.cd_data_receipts(actor_id,request_id,request_hash,result) values(p_actor,p_request,p_hash,result);
  end if;
  return result;
end;
$$;
revoke all on function public.cd_work_areas_call(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.cd_work_areas_call(uuid,text,uuid,text,jsonb) to service_role;
commit;
