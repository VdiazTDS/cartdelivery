-- Report only the current copy owner's confirmed sync time.
create index cd_data_history_owner_date on public.cd_data_history(file_id, actor_id, created_at desc);

create or replace function public.cd_data_describe(f public.cd_data_files, c public.cd_data_copies) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('fileId',f.id,'name',f.name,'sourceKey',f.source_key,'rowCount',f.row_count,
    'masterRevision',f.revision,'copyId',c.id,'copyRevision',c.revision,'baseRevision',c.base_revision,
    'pending',coalesce(c.pending_count,0),'fieldMapping',f.field_mapping,
    'lastSyncedAt',(select max(h.created_at) from public.cd_data_history h where h.file_id=f.id and h.actor_id=c.owner_id));
$$;
