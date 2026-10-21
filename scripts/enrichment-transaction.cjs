const assert = require('node:assert/strict');
const literal = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
const protectedTables = ['cd_data_copies', 'cd_data_drafts', 'cd_data_versions', 'cd_data_history', 'cd_data_history_changes', 'cd_data_receipts', 'cd_work_areas'];
const state = () => `jsonb_build_object(${protectedTables.map(table => `'${table}',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text) from public.${table} t)`).join(',')})`;

function enrichmentSql(plan, stagingTable = null) {
  assert(plan.files.length && plan.changes.length);
  assert.equal(new Set(plan.changes.map(r => r.file_id + ':' + r.row_index)).size, plan.changes.length);
  for (const row of plan.changes) {
    assert(plan.files.some(f => f.id === row.file_id));
    assert(Object.keys(row.fields).length);
    assert(!Object.keys(row.fields).some(k => ['del_qty', 'del_status', 'delivery_notes', '__proto__', 'constructor', 'prototype', '__rowNum__'].includes(k)));
    assert(/^[a-f0-9]{32}$/.test(row.expected_hash));
  }
  if (stagingTable) assert(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(stagingTable));
  const rowInput = stagingTable ? `(select jsonb_agg(to_jsonb(s)) from ${stagingTable} s)` : literal(plan.changes);
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';
select pg_advisory_xact_lock(7142026,1);
lock table public.cd_data_files,public.cd_data_records,${protectedTables.map(t => 'public.' + t).join(',')} in share row exclusive mode;
${stagingTable ? `lock table ${stagingTable} in share mode;` : ''}
create temp table enrichment_rows on commit drop as select * from jsonb_to_recordset(${rowInput}) as x(file_id uuid,row_index integer,fields jsonb,expected_hash text);
create temp table enrichment_files on commit drop as select * from jsonb_to_recordset(${literal(plan.files)}) as x(id uuid,old_path text,old_digest text,new_path text,new_digest text);
create temp table enrichment_old_files on commit drop as select f.* from public.cd_data_files f join enrichment_files p using(id);
create temp table enrichment_old_records on commit drop as select r.* from public.cd_data_records r join enrichment_files p on p.id=r.file_id;
create temp table enrichment_protected on commit drop as select ${state()} fingerprint;
do $checks$
begin
  if (select count(*) from enrichment_rows) <> ${plan.changes.length}
    or (select count(distinct (file_id,row_index)) from enrichment_rows) <> ${plan.changes.length}
    or exists(select 1 from enrichment_rows r where not exists(select 1 from enrichment_files f where f.id=r.file_id))
    then raise exception 'INVALID_STAGED_ROWS'; end if;
  if (select count(*) from enrichment_old_files) <> ${plan.files.length} then raise exception 'FILE_SET_CHANGED'; end if;
  if exists(select 1 from enrichment_old_files f join enrichment_files p using(id) where not f.ready or f.source_bucket <> 'profile-workbooks'
    or f.source_path is distinct from p.old_path or f.source_digest is distinct from p.old_digest) then raise exception 'SOURCE_CHANGED'; end if;
  if (select count(*) from public.cd_data_records r join enrichment_rows p using(file_id,row_index)) <> ${plan.changes.length}
    or exists(select 1 from public.cd_data_records r join enrichment_rows p using(file_id,row_index) where md5(r.data::text) <> p.expected_hash)
    then raise exception 'RECORDS_CHANGED'; end if;
  if exists(select 1 from public.cd_data_records r join enrichment_rows p using(file_id,row_index)
    cross join lateral jsonb_object_keys(p.fields) k where r.data ? k or k in ('del_qty','del_status','delivery_notes','__proto__','constructor','prototype','__rowNum__'))
    then raise exception 'EXISTING_FIELD_OVERWRITE'; end if;
  if exists(select 1 from enrichment_files p where not exists(select 1 from storage.objects o where o.bucket_id='profile-workbooks' and o.name=p.new_path))
    then raise exception 'ENRICHED_SOURCE_MISSING'; end if;
end;
$checks$;
update public.cd_data_records r set data=r.data||p.fields from enrichment_rows p where r.file_id=p.file_id and r.row_index=p.row_index;
update public.cd_data_files f set source_path=p.new_path,source_digest=p.new_digest from enrichment_files p where f.id=p.id;
do $checks$
begin
  if (select fingerprint from enrichment_protected) is distinct from ${state()} then raise exception 'DELIVERY_STATE_CHANGED'; end if;
  if exists(select 1 from enrichment_old_records old full join (select r.* from public.cd_data_records r join enrichment_files f on f.id=r.file_id) r using(file_id,row_index)
    left join enrichment_rows p using(file_id,row_index)
    where old.file_id is null or r.file_id is null or (r.data - array(select jsonb_object_keys(coalesce(p.fields,'{}'::jsonb)))) is distinct from old.data)
    then raise exception 'ORIGINAL_RECORD_CHANGED'; end if;
  if exists(select 1 from public.cd_data_records r join enrichment_rows p using(file_id,row_index) where not r.data @> p.fields)
    then raise exception 'ADDED_FIELDS_MISMATCH'; end if;
  if exists(select 1 from public.cd_data_files f join enrichment_old_files old using(id)
    where (to_jsonb(f)-array['source_path','source_digest']) is distinct from (to_jsonb(old)-array['source_path','source_digest']))
    then raise exception 'FILE_METADATA_CHANGED'; end if;
end;
$checks$;
select jsonb_build_object('updatedRecords',(select count(*) from enrichment_rows),'updatedFiles',(select count(*) from enrichment_files),
  'deliveryStateUnchanged',true,'originalRecordFieldsUnchanged',true,'protectedFingerprints',(select fingerprint from enrichment_protected)) result;
commit;`;
}
module.exports = { enrichmentSql, protectedTables };
