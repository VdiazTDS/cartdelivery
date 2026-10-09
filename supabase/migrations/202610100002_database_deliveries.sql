-- Excel is an immutable import/export source. Delivery records are transactional.
begin;

create table public.cd_data_files (
  id uuid primary key,
  name text not null,
  source_key text,
  source_bucket text not null,
  source_path text not null,
  source_digest text,
  owner_id uuid not null references public.cd_profiles(user_id),
  ready boolean not null default false,
  row_count integer not null default 0,
  revision bigint not null default 1,
  created_at timestamptz not null default now()
);
create unique index cd_data_file_name on public.cd_data_files(name) where ready;
create unique index cd_data_file_source on public.cd_data_files(source_key) where ready and source_key is not null;
create table public.cd_data_records (
  file_id uuid not null references public.cd_data_files(id),
  row_index integer not null check (row_index >= 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  primary key (file_id, row_index)
);
create table public.cd_data_versions (
  file_id uuid not null,
  row_index integer not null,
  revision bigint not null,
  values jsonb not null,
  primary key (file_id, row_index, revision),
  foreign key (file_id, row_index) references public.cd_data_records(file_id, row_index)
);
create table public.cd_data_copies (
  id uuid primary key,
  file_id uuid not null references public.cd_data_files(id),
  owner_id uuid not null references public.cd_profiles(user_id),
  revision bigint not null default 1,
  base_revision bigint not null,
  pending_count integer not null default 0,
  updated_at timestamptz not null default now(),
  unique(file_id, owner_id)
);
create table public.cd_data_drafts (
  copy_id uuid not null references public.cd_data_copies(id),
  row_index integer not null,
  values jsonb not null,
  primary key(copy_id, row_index)
);
create table public.cd_data_history (
  id uuid primary key,
  file_id uuid not null references public.cd_data_files(id),
  actor_id uuid not null references public.cd_profiles(user_id),
  profile_name text not null,
  created_at timestamptz not null default now(),
  before_revision bigint not null,
  after_revision bigint not null,
  change_count integer not null default 0,
  resolutions jsonb not null
);
create index cd_data_history_date on public.cd_data_history(file_id, created_at desc, id);
create table public.cd_data_history_changes (
  event_id uuid not null references public.cd_data_history(id),
  row_index integer not null,
  change jsonb not null,
  primary key(event_id,row_index)
);
create table public.cd_data_receipts (
  actor_id uuid not null references public.cd_profiles(user_id),
  request_id uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id, request_id)
);

create function public.cd_data_fields(r jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('del_qty', r->'del_qty', 'del_status', r->'del_status', 'delivery_notes', r->'delivery_notes');
$$;
create function public.cd_data_changed(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(k), '[]'::jsonb) from unnest(array['del_qty','del_status','delivery_notes']) k
  where coalesce(a->k, 'null'::jsonb) is distinct from coalesce(b->k, 'null'::jsonb);
$$;
create function public.cd_data_at(fid uuid, idx integer, rev bigint, initial jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce((select v.values from public.cd_data_versions v
    where v.file_id=fid and v.row_index=idx and v.revision<=rev order by v.revision desc limit 1), public.cd_data_fields(initial));
$$;
create function public.cd_data_validate(r jsonb, changes jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare n jsonb; qty numeric;
begin
  if jsonb_typeof(changes) is distinct from 'object' or exists
    (select 1 from jsonb_object_keys(changes) k where k not in ('del_qty','del_status','delivery_notes')) then
    raise exception 'INVALID_FIELDS';
  end if;
  n := r || changes;
  if changes ? 'delivery_notes' and (jsonb_typeof(changes->'delivery_notes') is distinct from 'string' or length(changes->>'delivery_notes')>2000) then
    raise exception 'INVALID_NOTES';
  end if;
  if changes ? 'del_qty' or changes ? 'del_status' then
    begin qty := (r->>'QTY')::numeric; exception when others then qty := null; end;
    if qty is null or qty<=0 or qty>9007199254740991 or trunc(qty)<>qty or qty='NaN'::numeric then
      if n->'del_qty' is distinct from '0'::jsonb and n->'del_qty' is distinct from '""'::jsonb then raise exception 'INVALID_QUANTITY'; end if;
    else
      if jsonb_typeof(n->'del_qty') is distinct from 'number' then raise exception 'INVALID_QUANTITY'; end if;
      if (n->>'del_qty')::numeric<0 or (n->>'del_qty')::numeric>qty or trunc((n->>'del_qty')::numeric)<>(n->>'del_qty')::numeric
        or n->>'del_status' is distinct from (case when (n->>'del_qty')::numeric=qty then 'Delivered' else '' end) then
        raise exception 'INVALID_QUANTITY';
      end if;
    end if;
    if coalesce(n->>'del_status', '?') not in ('','Delivered') then raise exception 'INVALID_STATUS'; end if;
  end if;
  return public.cd_data_fields(n);
end;
$$;
create function public.cd_data_preview(cid uuid)
returns table (row_index integer, base jsonb, mine jsonb, original jsonb, fields jsonb, conflict boolean)
language sql stable set search_path = '' as $$
  select d.row_index, r.data || b.v, r.data || d.values, r.data || o.v,
    public.cd_data_changed(b.v,d.values), b.v is distinct from o.v
  from public.cd_data_copies c join public.cd_data_files f on f.id=c.file_id
  join public.cd_data_drafts d on d.copy_id=c.id
  join public.cd_data_records r on r.file_id=c.file_id and r.row_index=d.row_index
  cross join lateral (select public.cd_data_at(f.id,r.row_index,c.base_revision,r.data) v) b
  cross join lateral (select public.cd_data_at(f.id,r.row_index,f.revision,r.data) v) o
  where c.id=cid;
$$;
create function public.cd_data_describe(f public.cd_data_files, c public.cd_data_copies) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('fileId',f.id,'name',f.name,'sourceKey',f.source_key,'rowCount',f.row_count,
    'masterRevision',f.revision,'copyId',c.id,'copyRevision',c.revision,'baseRevision',c.base_revision,'pending',coalesce(c.pending_count,0));
$$;

create function public.cd_data_call(p_actor uuid, p_username text, p_request uuid, p_hash text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  action text := p->>'action'; f public.cd_data_files; c public.cd_data_copies;
  receipt public.cd_data_receipts; result jsonb; item record; entry jsonb;
  idx integer; off integer := coalesce((p->>'offset')::integer,0);
  initial jsonb; baseline jsonb; current_values jsonb; next_values jsonb; fields jsonb;
  choices jsonb; choice jsonb; resolutions jsonb := coalesce(p->'resolutions','[]'::jsonb);
  delta jsonb; next_revision bigint; n integer; saved_file_id uuid;
  mutating boolean := action in ('import-start','import-batch','import-finish','open','save','sync');
begin
  if p_actor is null or p_username !~ '^[a-z0-9][a-z0-9_-]{2,29}$' then raise exception 'SIGN_IN_REQUIRED'; end if;
  insert into public.cd_profiles(user_id,display_name) values(p_actor,p_username)
    on conflict(user_id) do update set display_name=excluded.display_name;
  if mutating then
    if p_request is null then raise exception 'INVALID_REQUEST_ID'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_actor::text||p_request::text,2));
    select * into receipt from public.cd_data_receipts where actor_id=p_actor and request_id=p_request;
    if found then
      if receipt.request_hash<>p_hash then raise exception 'REQUEST_REUSED'; end if;
      return receipt.result;
    end if;
  end if;
  if action='list' then
    select coalesce(jsonb_agg(public.cd_data_describe(ff,cc) order by ff.name),'[]'::jsonb) into result
      from public.cd_data_files ff left join public.cd_data_copies cc on cc.file_id=ff.id and cc.owner_id=p_actor where ff.ready;
    return jsonb_build_object('username',p_username,'files',result);
  elsif action='import-start' then
    if length(p->>'name') not between 1 and 180 or p->>'name' !~* '\.(xlsx|xls|csv)$' or p->>'name' ~ '[/\\]' then raise exception 'INVALID_FILE'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p->>'name',3));
    select * into f from public.cd_data_files where ready and (name=p->>'name' or source_key=p->>'sourceKey') limit 1;
    if found then
      if p->>'sourceKey' is null or f.source_key is distinct from p->>'sourceKey' then raise exception 'NAME_EXISTS'; end if;
    else
      select * into f from public.cd_data_files where not ready and owner_id=p_actor and name=p->>'name'
        and source_key is not distinct from p->>'sourceKey' and source_digest is not distinct from p->>'digest' order by created_at desc limit 1;
      if not found then
        insert into public.cd_data_files(id,name,source_key,source_bucket,source_path,source_digest,owner_id)
          values((p->>'newFileId')::uuid,p->>'name',p->>'sourceKey',p->>'sourceBucket',p->>'sourcePath',p->>'digest',p_actor) returning * into f;
      end if;
    end if;
    result := public.cd_data_describe(f,c)||jsonb_build_object('ready',f.ready,'sourceBucket',f.source_bucket,'sourcePath',f.source_path);
  else
    select * into f from public.cd_data_files where id=(p->>'fileId')::uuid for update;
    if not found then raise exception 'FILE_NOT_FOUND'; end if;
    if action in ('import-batch','import-finish') then
      if f.owner_id<>p_actor or f.ready then raise exception 'INVALID_IMPORT'; end if;
      if action='import-batch' then
        if jsonb_typeof(p->'rows') is distinct from 'array' or jsonb_array_length(p->'rows') not between 1 and 250
          or (p->>'offset')::integer is distinct from f.row_count then raise exception 'INVALID_IMPORT_BATCH'; end if;
        n := jsonb_array_length(p->'rows');
        if f.row_count+n>100000 then raise exception 'INVALID_ROW_COUNT'; end if;
        for entry in select value from jsonb_array_elements(p->'rows') loop
          if jsonb_typeof(entry) is distinct from 'object' or octet_length(entry::text)>65536 or exists
            (select 1 from jsonb_each(entry) x where jsonb_typeof(x.value) not in ('string','number','boolean','null') or x.key in ('__proto__','__rowNum__','constructor','prototype')) then
            raise exception 'INVALID_ROW';
          end if;
        end loop;
        insert into public.cd_data_records(file_id,row_index,data)
          select f.id,f.row_count+ordinality::integer-1,value from jsonb_array_elements(p->'rows') with ordinality;
        update public.cd_data_files set row_count=row_count+n where id=f.id returning * into f;
      else
        if f.row_count<1 or f.row_count is distinct from (p->>'rowCount')::integer then raise exception 'INVALID_ROW_COUNT'; end if;
        perform pg_advisory_xact_lock(hashtextextended(f.name,3));
        select id into saved_file_id from public.cd_data_files where ready and (name=f.name or source_key=f.source_key) limit 1;
        if found then
          if f.source_key is null or (select source_key from public.cd_data_files where id=saved_file_id) is distinct from f.source_key then raise exception 'NAME_EXISTS'; end if;
          select * into f from public.cd_data_files where id=saved_file_id;
        else
          update public.cd_data_files set ready=true where id=f.id returning * into f;
        end if;
      end if;
      result := public.cd_data_describe(f,c)||jsonb_build_object('ready',f.ready);
    else
      if not f.ready then raise exception 'FILE_NOT_FOUND'; end if;
      select * into c from public.cd_data_copies where file_id=f.id and owner_id=p_actor for update;
      if action='open' then
        if c.id is null then
          insert into public.cd_data_copies(id,file_id,owner_id,base_revision) values(gen_random_uuid(),f.id,p_actor,f.revision) returning * into c;
        end if;
        result := public.cd_data_describe(f,c);
      elsif action='original' then result := public.cd_data_describe(f,null::public.cd_data_copies)||jsonb_build_object('mode','original');
      elsif action='export-source' then
        result := jsonb_build_object('sourceBucket',f.source_bucket,'sourcePath',f.source_path);
      elsif action='rows' then
        if off<0 then raise exception 'INVALID_OFFSET'; end if;
        if p->>'mode'='original' then
          if (p->>'masterRevision')::bigint is distinct from f.revision then raise exception 'STALE_VERSION'; end if;
          select coalesce(jsonb_agg(data order by row_index),'[]'::jsonb) into result from
            (select r.row_index,r.data||public.cd_data_at(f.id,r.row_index,f.revision,r.data) data
              from public.cd_data_records r where r.file_id=f.id and r.row_index>=off order by r.row_index limit 250) q;
        else
          if c.id is null then raise exception 'COPY_NOT_FOUND'; end if;
          if (p->>'copyRevision')::bigint is distinct from c.revision then raise exception 'STALE_VERSION'; end if;
          select coalesce(jsonb_agg(data order by row_index),'[]'::jsonb) into result from
            (select r.row_index,r.data||coalesce(d.values,public.cd_data_at(f.id,r.row_index,c.base_revision,r.data)) data
              from public.cd_data_records r left join public.cd_data_drafts d on d.copy_id=c.id and d.row_index=r.row_index
              where r.file_id=f.id and r.row_index>=off order by r.row_index limit 250) q;
        end if;
        return jsonb_build_object('rows',result,'offset',off,'rowCount',f.row_count);
      elsif action='history' then
        if off<0 then raise exception 'INVALID_OFFSET'; end if;
        select coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) into result from
          (select h.id,h.profile_name,h.created_at,h.before_revision,h.after_revision,h.change_count,jsonb_array_length(h.resolutions) resolution_count from public.cd_data_history h
            where h.file_id=f.id order by h.created_at desc,h.id limit 25 offset off) h;
        return jsonb_build_object('history',result);
      elsif action='history-changes' then
        if off<0 then raise exception 'INVALID_OFFSET'; end if;
        select h.resolutions into resolutions from public.cd_data_history h where h.id=(p->>'eventId')::uuid and h.file_id=f.id;
        if not found then raise exception 'INVALID_HISTORY'; end if;
        select coalesce(jsonb_agg(q.change),'[]'::jsonb) into result from
          (select h.change from public.cd_data_history_changes h where h.event_id=(p->>'eventId')::uuid order by h.row_index limit 250 offset off) q;
        select coalesce(jsonb_agg(q.value),'[]'::jsonb) into choices from
          (select value from jsonb_array_elements(resolutions) with ordinality order by ordinality limit 250 offset off) q;
        return jsonb_build_object('changes',result,'resolutions',choices);
      else
        if c.id is null then raise exception 'COPY_NOT_FOUND'; end if;
        if action='preview' then
          if off<0 then raise exception 'INVALID_OFFSET'; end if;
          if off>0 and ((p->>'copyRevision')::bigint is distinct from c.revision or (p->>'masterRevision')::bigint is distinct from f.revision) then raise exception 'STALE_VERSION'; end if;
          select coalesce(jsonb_agg(jsonb_build_object('index',v.row_index,'base',v.base,'mine',v.mine,'original',v.original,'fields',v.fields,'conflict',v.conflict)),'[]'::jsonb)
            into result from (select * from public.cd_data_preview(c.id) order by row_index limit 250 offset off) v;
          return public.cd_data_describe(f,c)||jsonb_build_object('changes',result);
        end if;
        if (p->>'copyRevision')::bigint is distinct from c.revision then raise exception 'STALE_VERSION'; end if;
        if action='save' then
          if jsonb_typeof(p->'edits') is distinct from 'array' or jsonb_array_length(p->'edits') not between 1 and 100000 then raise exception 'INVALID_EDITS'; end if;
          if (select count(distinct value->>'index') from jsonb_array_elements(p->'edits'))<>jsonb_array_length(p->'edits') then raise exception 'INVALID_ROW'; end if;
          for entry in select value from jsonb_array_elements(p->'edits') loop
            if jsonb_typeof(entry->'index') is distinct from 'number' or (entry->>'index')::numeric<>trunc((entry->>'index')::numeric) then raise exception 'INVALID_ROW'; end if;
            idx := (entry->>'index')::integer;
            select data into initial from public.cd_data_records where file_id=f.id and row_index=idx;
            if not found then raise exception 'INVALID_ROW'; end if;
            baseline := public.cd_data_at(f.id,idx,c.base_revision,initial);
            select values into current_values from public.cd_data_drafts where copy_id=c.id and row_index=idx;
            next_values := public.cd_data_validate(initial||coalesce(current_values,baseline),entry->'values');
            if next_values=baseline then delete from public.cd_data_drafts where copy_id=c.id and row_index=idx;
            else insert into public.cd_data_drafts(copy_id,row_index,values) values(c.id,idx,next_values)
              on conflict(copy_id,row_index) do update set values=excluded.values;
            end if;
          end loop;
          update public.cd_data_copies set revision=revision+1,updated_at=now(),pending_count=(select count(*) from public.cd_data_drafts where copy_id=c.id)
            where id=c.id returning * into c;
        elsif action='sync' then
          if (p->>'masterRevision')::bigint is distinct from f.revision then raise exception 'STALE_VERSION'; end if;
          if jsonb_typeof(resolutions) is distinct from 'array' then raise exception 'INVALID_RESOLUTION'; end if;
          if (select count(distinct value->>'index') from jsonb_array_elements(resolutions))<>jsonb_array_length(resolutions) then raise exception 'INVALID_RESOLUTION'; end if;
          if exists(select 1 from jsonb_array_elements(resolutions) x where not exists
            (select 1 from public.cd_data_preview(c.id) v where v.conflict and v.row_index::text=x.value->>'index')) then raise exception 'INVALID_RESOLUTION'; end if;
          select coalesce(jsonb_object_agg(value->>'index',value),'{}'::jsonb) into choices from jsonb_array_elements(resolutions);
          next_revision := f.revision+1;
          n := 0;
          insert into public.cd_data_history(id,file_id,actor_id,profile_name,before_revision,after_revision,resolutions)
            values(p_request,f.id,p_actor,p_username,f.revision,next_revision,resolutions);
          for item in select * from public.cd_data_preview(c.id) order by row_index loop
            select coalesce(jsonb_object_agg(k,item.mine->k),'{}'::jsonb) into delta from jsonb_array_elements_text(item.fields) k;
            if delta ? 'del_qty' or delta ? 'del_status' then delta := delta||jsonb_build_object('del_qty',coalesce(item.mine->'del_qty','""'::jsonb),'del_status',coalesce(item.mine->'del_status','""'::jsonb)); end if;
            if item.conflict then
              choice := choices->item.row_index::text;
              if choice is null then raise exception 'UNRESOLVED_CONFLICT'; end if;
              if choice->>'choice'='original' then continue;
              elsif choice->>'choice'='count' then
                delta := delta||jsonb_build_object('del_qty',choice->'count','del_status',case when (choice->>'count')::numeric=(item.original->>'QTY')::numeric then 'Delivered' else '' end);
                perform public.cd_data_validate(item.original,delta);
              elsif choice->>'choice'<>'mine' or choice->>'choice' is null then raise exception 'INVALID_RESOLUTION';
              end if;
            end if;
            next_values := public.cd_data_fields(item.original||delta);
            fields := public.cd_data_changed(item.original,next_values);
            if jsonb_array_length(fields)=0 then continue; end if;
            insert into public.cd_data_versions(file_id,row_index,revision,values) values(f.id,item.row_index,next_revision,next_values);
            select jsonb_agg(jsonb_build_object('field',k,'before',item.original->k,'after',next_values->k)) into delta from jsonb_array_elements_text(fields) k;
            insert into public.cd_data_history_changes(event_id,row_index,change) values(p_request,item.row_index,
              jsonb_build_object('index',item.row_index,'address',concat_ws(' ',item.original->>'CSADR#',item.original->>'CSSDIR',item.original->>'CSSTRT',item.original->>'CSSFUX'),'bin',coalesce(item.original->>'BINNO',''),'fields',delta));
            n := n+1;
          end loop;
          if n=0 then next_revision:=f.revision; end if;
          update public.cd_data_history set after_revision=next_revision,change_count=n where id=p_request;
          update public.cd_data_files set revision=next_revision where id=f.id returning * into f;
          delete from public.cd_data_drafts where copy_id=c.id;
          update public.cd_data_copies set base_revision=f.revision,revision=revision+1,pending_count=0,updated_at=now() where id=c.id returning * into c;
        else raise exception 'INVALID_ACTION';
        end if;
        result := public.cd_data_describe(f,c);
      end if;
    end if;
  end if;
  if mutating then insert into public.cd_data_receipts(actor_id,request_id,request_hash,result) values(p_actor,p_request,p_hash,result); end if;
  return result;
end;
$$;

-- Retain the old tables and objects; copy existing confirmed states into the new model.
insert into public.cd_data_files(id,name,source_key,source_bucket,source_path,owner_id,ready,row_count,revision,created_at)
  select id,name,source_key,'profile-workbooks',workbook_path,created_by,true,jsonb_array_length(rows),revision,created_at from public.cd_files;
insert into public.cd_data_records(file_id,row_index,data)
  select f.id,r.ordinality::integer-1,r.value from public.cd_files f cross join lateral jsonb_array_elements(f.rows) with ordinality r;
insert into public.cd_data_versions(file_id,row_index,revision,values)
  select c.file_id,r.ordinality::integer-1,c.base_revision,public.cd_data_fields(r.value)
    from public.cd_copies c cross join lateral jsonb_array_elements(c.base_rows) with ordinality r on conflict do nothing;
insert into public.cd_data_versions(file_id,row_index,revision,values)
  select f.id,r.ordinality::integer-1,f.revision,public.cd_data_fields(r.value)
    from public.cd_files f cross join lateral jsonb_array_elements(f.rows) with ordinality r on conflict do nothing;
insert into public.cd_data_copies select id,file_id,owner_id,revision,base_revision,pending_count,updated_at from public.cd_copies;
insert into public.cd_data_drafts(copy_id,row_index,values)
  select c.id,r.ordinality::integer-1,public.cd_data_fields(r.value) from public.cd_copies c
    cross join lateral jsonb_array_elements(c.rows) with ordinality r
    where public.cd_data_fields(r.value) is distinct from public.cd_data_fields(c.base_rows->(r.ordinality::integer-1));
insert into public.cd_data_history select id,file_id,actor_id,profile_name,created_at,before_revision,after_revision,jsonb_array_length(changes),resolutions from public.cd_syncs;
insert into public.cd_data_history_changes select s.id,(c.value->>'index')::integer,c.value from public.cd_syncs s cross join lateral jsonb_array_elements(s.changes) c;

do $$ declare t text; fn record; begin
  foreach t in array array['cd_data_files','cd_data_records','cd_data_versions','cd_data_copies','cd_data_drafts','cd_data_history','cd_data_history_changes','cd_data_receipts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'cd_data_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $$;
commit;
