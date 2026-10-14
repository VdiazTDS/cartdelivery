begin;

-- Deletion markers may only be written by the admin Edge Function.
create policy cd_load_deletion_insert on storage.objects as restrictive
for insert to anon, authenticated with check (
  bucket_id <> 'excel-files' or not starts_with(name, '_cart-loads/deleted-')
);
create policy cd_load_log_update on storage.objects as restrictive
for update to anon, authenticated
using (bucket_id <> 'excel-files' or not starts_with(name, '_cart-loads/'))
with check (bucket_id <> 'excel-files' or not starts_with(name, '_cart-loads/'));
create policy cd_load_log_delete on storage.objects as restrictive
for delete to anon, authenticated
using (bucket_id <> 'excel-files' or not starts_with(name, '_cart-loads/'));

commit;
