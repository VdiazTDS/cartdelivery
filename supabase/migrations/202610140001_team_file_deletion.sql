begin;

-- A small tombstone makes storage cleanup retryable after the records are removed.
create table public.cd_file_deletions (
  id uuid primary key,
  name text not null,
  source_key text,
  file_ids uuid[] not null,
  import_requests text[] not null,
  objects jsonb not null,
  complete boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.cd_file_deletions enable row level security;
revoke all on public.cd_file_deletions from public,anon,authenticated;
grant all on public.cd_file_deletions to service_role;

create function public.cd_file_delete_call(p_actor uuid, p_username text, p_request uuid, p_hash text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.cd_data_files; job public.cd_file_deletions;
  target uuid; source_id uuid; filename text; source text; ids uuid[]; old_ids uuid[];
  objects jsonb; summary jsonb;
begin
  if p_actor is null or not exists(select 1 from auth.users where id=p_actor
    and email=p_username||'@profiles.cartdelivery.invalid'
    and email ~ '^[a-z0-9][a-z0-9_-]{2,29}@profiles\.cartdelivery\.invalid$') then
    raise exception 'SIGN_IN_REQUIRED';
  end if;
  if exists(select 1 from auth.users where id=p_actor and (deleted_at is not null
    or banned_until>now() or raw_app_meta_data->>'cartdelivery_disabled'='true')) then raise exception 'PROFILE_DISABLED'; end if;
  if p->>'action' not in ('delete-preview','delete-start','delete-finish') or p->>'action' is null then
    raise exception 'INVALID_ACTION';
  end if;
  if p->>'action'<>'delete-preview' and p->>'confirmation' is distinct from 'Confirm' then
    raise exception 'INVALID_DELETE_CONFIRMATION';
  end if;
  perform pg_advisory_xact_lock(7142026,1);
  target := coalesce((p->>'deletionId')::uuid,(p->>'fileId')::uuid,(p->>'sourceObjectId')::uuid);
  select * into job from public.cd_file_deletions where id=target or target=any(file_ids)
    or (p->>'fileId' is null and source_key=p->>'sourceKey') limit 1;
  if found then
    if p->>'action'<>'delete-preview' and (p->>'confirmName' is distinct from job.name or p->'acknowledged' is distinct from 'true'::jsonb) then
      raise exception 'INVALID_DELETE_CONFIRMATION';
    end if;
    if p->>'action'='delete-finish' then
      update public.cd_file_deletions set complete=true,objects='[]'::jsonb where id=job.id returning * into job;
    end if;
    return jsonb_build_object('deletionId',job.id,'name',job.name,'sourceKey',job.source_key,
      'fileIds',job.file_ids,'deleting',true,'deleted',job.complete,'objects',job.objects);
  end if;
  if p->>'deletionId' is not null or p->>'action'='delete-finish' then raise exception 'FILE_NOT_FOUND'; end if;
  if p->>'fileId' is not null then
    select * into f from public.cd_data_files where id=(p->>'fileId')::uuid and ready;
    if not found then raise exception 'FILE_NOT_FOUND'; end if;
    target := f.id; filename := f.name; source := f.source_key;
  else
    source := p->>'sourceKey'; filename := source;
    if length(source) not between 1 and 180 or source !~* '\.(xlsx|xls|csv)$'
      or source ~ '[/\\[:cntrl:]]' or source is null then raise exception 'INVALID_FILE'; end if;
    select id into source_id from storage.objects where bucket_id='excel-files' and name=source;
    if source_id is null then raise exception 'FILE_NOT_FOUND'; end if;
    if p->>'action'='delete-start' and (p->>'sourceObjectId')::uuid is distinct from source_id then
      raise exception 'INVALID_DELETE_TARGET';
    end if;
    target := source_id;
    select * into f from public.cd_data_files where source_key=source and ready;
  end if;
  select coalesce(array_agg(id),'{}'::uuid[]) into ids from public.cd_data_files
    where id=f.id or (source is not null and source_key=source);
  select coalesce(array_agg(id),'{}'::uuid[]) into old_ids from public.cd_files
    where id=any(ids) or (source is not null and source_key=source);
  summary := jsonb_build_object('fileId',case when p->>'fileId' is not null then f.id else null end,
    'sourceObjectId',source_id,'sourceKey',source,'name',filename,
    'rowCount',coalesce(f.row_count,0),
    'copyCount',(select count(*) from public.cd_data_copies where file_id=any(ids)),
    'pendingCount',(select coalesce(sum(pending_count),0) from public.cd_data_copies where file_id=any(ids)),
    'historyCount',(select count(*) from public.cd_data_history where file_id=any(ids)),
    'areaCount',(select coalesce(sum(jsonb_array_length(areas)),0) from public.cd_work_areas where file_id=any(ids)));
  if p->>'action'='delete-preview' then return summary; end if;
  if p->>'confirmName' is distinct from filename or p->'acknowledged' is distinct from 'true'::jsonb then
    raise exception 'INVALID_DELETE_CONFIRMATION';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'path',path)),'[]'::jsonb) into objects from (
    select source_bucket bucket,source_path path from public.cd_data_files where id=any(ids)
    union select 'excel-files',source where source is not null
    union select 'profile-workbooks',original_path from public.cd_files where id=any(old_ids)
    union select 'profile-workbooks',workbook_path from public.cd_files where id=any(old_ids)
    union select 'profile-workbooks',workbook_path from public.cd_copies where file_id=any(old_ids)
    union select 'profile-workbooks',before_path from public.cd_syncs where file_id=any(old_ids)
    union select 'profile-workbooks',after_path from public.cd_syncs where file_id=any(old_ids)
    union select 'profile-workbooks',result->>'path' from public.cd_receipts
      where result->>'fileId'=any(old_ids::text[]) and result->>'path' is not null
  ) paths;
  insert into public.cd_file_deletions(id,name,source_key,file_ids,import_requests,objects)
    values(target,filename,source,ids,(select coalesce(array_agg(actor_id::text||request_id::text),'{}'::text[])
      from public.cd_data_receipts where result->>'fileId'=any(ids::text[]) and result ? 'sourceBucket'),objects);
  delete from public.cd_data_history_changes where event_id in (select id from public.cd_data_history where file_id=any(ids));
  delete from public.cd_data_history where file_id=any(ids);
  delete from public.cd_data_drafts where copy_id in (select id from public.cd_data_copies where file_id=any(ids));
  delete from public.cd_data_copies where file_id=any(ids);
  delete from public.cd_data_versions where file_id=any(ids);
  delete from public.cd_data_records where file_id=any(ids);
  delete from public.cd_work_areas where file_id=any(ids);
  delete from public.cd_data_receipts where result->>'fileId'=any(ids::text[]);
  delete from public.cd_data_files where id=any(ids);
  delete from public.cd_copies where file_id=any(old_ids);
  delete from public.cd_syncs where file_id=any(old_ids);
  delete from public.cd_receipts where result->>'fileId'=any(old_ids::text[]);
  delete from public.cd_files where id=any(old_ids);
  return summary || jsonb_build_object('deletionId',target,'fileIds',ids,'objects',objects,'deleted',false,'deleting',true);
end;
$$;

-- All current writes share this lock; deletion waits for in-flight saves/imports.
alter function public.cd_data_call(uuid,text,uuid,text,jsonb) rename to cd_data_call_before_delete;
create function public.cd_data_call(p_actor uuid,p_username text,p_request uuid,p_hash text,p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock_shared(7142026,1);
  if exists(select 1 from public.cd_file_deletions where
    (p->>'fileId')::uuid=any(file_ids) or
    (p->>'action'='import-start' and (p_actor::text||p_request::text=any(import_requests)
      or (source_key is not null and source_key=p->>'sourceKey')
      or (not complete and name=p->>'name')))) then raise exception 'FILE_DELETED'; end if;
  return public.cd_data_call_before_delete(p_actor,p_username,p_request,p_hash,p);
end;
$$;
alter function public.cd_work_areas_call(uuid,text,uuid,text,jsonb) rename to cd_work_areas_before_delete;
create function public.cd_work_areas_call(p_actor uuid,p_username text,p_request uuid,p_hash text,p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock_shared(7142026,1);
  return public.cd_work_areas_before_delete(p_actor,p_username,p_request,p_hash,p);
end;
$$;
revoke all on function public.cd_file_delete_call(uuid,text,uuid,text,jsonb),
  public.cd_data_call(uuid,text,uuid,text,jsonb),public.cd_work_areas_call(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.cd_file_delete_call(uuid,text,uuid,text,jsonb),
  public.cd_data_call(uuid,text,uuid,text,jsonb),public.cd_work_areas_call(uuid,text,uuid,text,jsonb) to service_role;
commit;
