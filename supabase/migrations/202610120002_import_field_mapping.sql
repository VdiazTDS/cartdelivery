-- Keep the original workbook unchanged and describe how its columns were imported.
alter table public.cd_data_files add column field_mapping jsonb;

create or replace function public.cd_data_describe(f public.cd_data_files, c public.cd_data_copies) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('fileId',f.id,'name',f.name,'sourceKey',f.source_key,'rowCount',f.row_count,
    'masterRevision',f.revision,'copyId',c.id,'copyRevision',c.revision,'baseRevision',c.base_revision,
    'pending',coalesce(c.pending_count,0),'fieldMapping',f.field_mapping);
$$;

create function public.cd_data_import_mapped(p_actor uuid, p_username text, p_request uuid, p_hash text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mapping jsonb := p->'fieldMapping'; result jsonb; f public.cd_data_files;
begin
  if p->>'action' is distinct from 'import-start' or p->>'sourceKey' is not null
    or jsonb_typeof(mapping) is distinct from 'object' then raise exception 'INVALID_MAPPING'; end if;
  if exists (select 1 from jsonb_each(mapping) e where e.key not in
    ('LATITUDE','LONGITUDE','ROUTE','DAY','CSADR#','CSSDIR','CSSTRT','CSSFUX','SIZE','BINNO','QTY','SEQNO','del_qty','del_status','delivery_notes')
    or jsonb_typeof(e.value) is distinct from 'string' or length(e.value #>> '{}') not between 1 and 200
    or (e.value #>> '{}') in ('__proto__','constructor','prototype','__rowNum__'))
    or not (mapping ? 'LATITUDE' and mapping ? 'LONGITUDE')
    or (select count(*) from jsonb_each(mapping)) <> (select count(distinct value) from jsonb_each(mapping))
    then raise exception 'INVALID_MAPPING'; end if;
  -- A retry may only resume batches imported with these same column choices.
  p := jsonb_set(p,'{digest}',to_jsonb((p->>'digest') || ':' || mapping::text));
  result := public.cd_data_call(p_actor,p_username,p_request,p_hash,p);
  select * into f from public.cd_data_files where id=(result->>'fileId')::uuid for update;
  if f.owner_id is distinct from p_actor or (f.field_mapping is not null and f.field_mapping is distinct from mapping)
    then raise exception 'INVALID_MAPPING'; end if;
  if not f.ready then update public.cd_data_files set field_mapping=mapping where id=f.id; end if;
  return result || jsonb_build_object('fieldMapping',mapping);
end;
$$;
revoke all on function public.cd_data_import_mapped(uuid,text,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.cd_data_import_mapped(uuid,text,uuid,text,jsonb) to service_role;
