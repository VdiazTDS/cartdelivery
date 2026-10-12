-- The Edge Function exposes these reads; profile copies and all writes remain private.
create function public.cd_data_public_read(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  action text := p->>'action'; f public.cd_data_files; result jsonb;
  off integer := coalesce((p->>'offset')::integer,0);
begin
  if action not in ('public-list','public-original','public-rows','public-export-source') or action is null then
    raise exception 'SIGN_IN_REQUIRED';
  end if;
  if action='public-list' then
    select coalesce(jsonb_agg(public.cd_data_describe(ff,null::public.cd_data_copies) order by ff.name),'[]'::jsonb)
      into result from public.cd_data_files ff where ff.ready;
    return jsonb_build_object('files',result);
  end if;
  select * into f from public.cd_data_files where id=(p->>'fileId')::uuid and ready;
  if not found then raise exception 'FILE_NOT_FOUND'; end if;
  if action='public-original' then
    return public.cd_data_describe(f,null::public.cd_data_copies)||jsonb_build_object('mode','original');
  elsif action='public-export-source' then
    return jsonb_build_object('sourceBucket',f.source_bucket,'sourcePath',f.source_path);
  end if;
  if p->>'mode' is distinct from 'original' then raise exception 'SIGN_IN_REQUIRED'; end if;
  if off<0 then raise exception 'INVALID_OFFSET'; end if;
  if (p->>'masterRevision')::bigint is distinct from f.revision then raise exception 'STALE_VERSION'; end if;
  select coalesce(jsonb_agg(data order by row_index),'[]'::jsonb) into result from
    (select r.row_index,r.data||public.cd_data_at(f.id,r.row_index,f.revision,r.data) data
      from public.cd_data_records r where r.file_id=f.id and r.row_index>=off order by r.row_index limit 250) q;
  return jsonb_build_object('rows',result,'offset',off,'rowCount',f.row_count);
end;
$$;
revoke all on function public.cd_data_public_read(jsonb) from public, anon, authenticated;
grant execute on function public.cd_data_public_read(jsonb) to service_role;
