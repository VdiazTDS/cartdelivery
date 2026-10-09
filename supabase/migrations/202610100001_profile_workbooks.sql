-- Deploy before the profile-workbooks Edge Function and updated frontend.
begin;

create table public.cd_profiles (
  user_id uuid primary key references auth.users(id),
  display_name text not null unique check (length(display_name) between 1 and 80)
);
create table public.cd_files (
  id uuid primary key,
  name text not null unique,
  source_key text unique,
  revision bigint not null default 1,
  original_path text not null,
  workbook_path text not null,
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  created_by uuid not null references public.cd_profiles(user_id),
  created_at timestamptz not null default now()
);
create table public.cd_copies (
  id uuid primary key,
  file_id uuid not null references public.cd_files(id),
  owner_id uuid not null references public.cd_profiles(user_id),
  revision bigint not null default 1,
  base_revision bigint not null,
  base_rows jsonb not null,
  rows jsonb not null,
  pending_count integer not null default 0,
  workbook_path text not null,
  updated_at timestamptz not null default now(),
  unique (file_id, owner_id)
);
create table public.cd_syncs (
  id uuid primary key,
  file_id uuid not null references public.cd_files(id),
  actor_id uuid not null references public.cd_profiles(user_id),
  profile_name text not null,
  created_at timestamptz not null default now(),
  before_revision bigint not null,
  after_revision bigint not null,
  changes jsonb not null,
  resolutions jsonb not null,
  before_path text not null,
  after_path text not null
);
create index cd_syncs_file_date on public.cd_syncs(file_id, created_at desc, id);
create table public.cd_receipts (
  actor_id uuid not null references public.cd_profiles(user_id),
  request_id uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, request_id)
);

alter table public.cd_profiles enable row level security;
alter table public.cd_files enable row level security;
alter table public.cd_copies enable row level security;
alter table public.cd_syncs enable row level security;
alter table public.cd_receipts enable row level security;
revoke all on public.cd_profiles, public.cd_files, public.cd_copies, public.cd_syncs, public.cd_receipts from anon, authenticated;
grant all on public.cd_profiles, public.cd_files, public.cd_copies, public.cd_syncs, public.cd_receipts to service_role;

-- Immutable files are uploaded before this transaction switches the visible version.
-- A failed upload/commit leaves an unreferenced object, never a half-saved workbook.
create function public.cd_commit(p_action text, p_actor uuid, p_request uuid, p_hash text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.cd_files;
  c public.cd_copies;
  receipt public.cd_receipts;
  result jsonb;
  next_revision bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || p_request::text, 0));
  select * into receipt from public.cd_receipts where actor_id = p_actor and request_id = p_request;
  if found then
    if receipt.request_hash <> p_hash then raise exception 'REQUEST_REUSED'; end if;
    return receipt.result;
  end if;

  if p_action = 'import' then
    perform pg_advisory_xact_lock(hashtextextended(p->>'name', 1));
    select * into f from public.cd_files where name = p->>'name';
    if found then
      if p->>'source_key' is null or f.source_key is distinct from p->>'source_key' then
        raise exception 'NAME_EXISTS';
      end if;
    else
      insert into public.cd_files(id, name, source_key, original_path, workbook_path, rows, created_by)
      values ((p->>'id')::uuid, p->>'name', p->>'source_key', p->>'original_path', p->>'path', p->'rows', p_actor)
      returning * into f;
    end if;
    result := jsonb_build_object('fileId', f.id, 'name', f.name);
  else
    select * into f from public.cd_files where id = (p->>'file_id')::uuid for update;
    if not found then raise exception 'FILE_NOT_FOUND'; end if;
    select * into c from public.cd_copies where file_id = f.id and owner_id = p_actor for update;
    if p_action = 'open' then
      if c.id is null then
        if f.revision <> (p->>'master_revision')::bigint then raise exception 'STALE_VERSION'; end if;
        insert into public.cd_copies(id, file_id, owner_id, base_revision, base_rows, rows, workbook_path)
        values ((p->>'id')::uuid, f.id, p_actor, f.revision, f.rows, f.rows, p->>'path')
        returning * into c;
      end if;
    elsif p_action in ('save', 'sync') then
      if c.id is null then raise exception 'COPY_NOT_FOUND'; end if;
      if c.revision <> (p->>'copy_revision')::bigint then raise exception 'STALE_VERSION'; end if;
      if p_action = 'save' then
        update public.cd_copies set rows = p->'rows', workbook_path = p->>'path',
          pending_count = (select count(*) from jsonb_array_elements(p->'rows') with ordinality x(value, n)
            where value is distinct from c.base_rows->(n::int - 1)),
          revision = revision + 1, updated_at = now() where id = c.id returning * into c;
      else
        if f.revision <> (p->>'master_revision')::bigint then raise exception 'STALE_VERSION'; end if;
        next_revision := f.revision + case when jsonb_array_length(p->'changes') > 0 then 1 else 0 end;
        insert into public.cd_syncs(id, file_id, actor_id, profile_name, before_revision, after_revision,
          changes, resolutions, before_path, after_path)
        values (p_request, f.id, p_actor, (select display_name from public.cd_profiles where user_id = p_actor),
          f.revision, next_revision, p->'changes', p->'resolutions', f.workbook_path, p->>'path');
        update public.cd_files set rows = p->'rows', revision = next_revision, workbook_path = p->>'path'
          where id = f.id returning * into f;
        update public.cd_copies set rows = f.rows, base_rows = f.rows, base_revision = f.revision,
          pending_count = 0,
          workbook_path = p->>'copy_path', revision = revision + 1, updated_at = now()
          where id = c.id returning * into c;
      end if;
    else
      raise exception 'INVALID_ACTION';
    end if;
    result := jsonb_build_object('fileId', f.id, 'name', f.name, 'copyId', c.id,
      'copyRevision', c.revision, 'masterRevision', f.revision, 'path', c.workbook_path,
      'pending', c.pending_count);
  end if;
  insert into public.cd_receipts(actor_id, request_id, request_hash, result)
    values (p_actor, p_request, p_hash, result);
  return result;
end;
$$;
revoke all on function public.cd_commit(text, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.cd_commit(text, uuid, uuid, text, jsonb) to service_role;

insert into storage.buckets(id, name, public) values ('profile-workbooks', 'profile-workbooks', false);
create policy "profile users read legacy sources" on storage.objects
  for select to authenticated using (bucket_id = 'excel-files');
create policy "profile users manage shared metadata" on storage.objects
  for all to authenticated
  using (bucket_id = 'excel-files' and (name = '_cart-delivery-tab.json' or starts_with(name, '_cart-loads/')))
  with check (bucket_id = 'excel-files' and (name = '_cart-delivery-tab.json' or starts_with(name, '_cart-loads/')));
-- Restrictive policies also constrain any pre-existing broad permissive policy.
create policy "profile workbook objects are server managed" on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'profile-workbooks') with check (bucket_id <> 'profile-workbooks');
create policy "legacy route inserts are frozen" on storage.objects as restrictive
  for insert to anon, authenticated with check
  (bucket_id <> 'excel-files' or name = '_cart-delivery-tab.json' or starts_with(name, '_cart-loads/'));
create policy "legacy route updates are frozen" on storage.objects as restrictive
  for update to anon, authenticated using
  (bucket_id <> 'excel-files' or name = '_cart-delivery-tab.json' or starts_with(name, '_cart-loads/')) with check
  (bucket_id <> 'excel-files' or name = '_cart-delivery-tab.json' or starts_with(name, '_cart-loads/'));
create policy "legacy route deletes are frozen" on storage.objects as restrictive
  for delete to anon, authenticated using
  (bucket_id <> 'excel-files' or name = '_cart-delivery-tab.json' or starts_with(name, '_cart-loads/'));
commit;
