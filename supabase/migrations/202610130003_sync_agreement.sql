begin;

-- Compare delivery meaning, including legacy status-only imports.
create function public.cd_data_delivery_value(r jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare qty numeric; count numeric; done boolean;
begin
  begin qty := (r->>'QTY')::numeric; exception when others then qty := null; end;
  done := lower(btrim(coalesce(r->>'del_status',''))) = 'delivered';
  if qty is null or qty<=0 or qty>9007199254740991 or trunc(qty)<>qty or qty='NaN'::numeric then
    return to_jsonb(done);
  end if;
  begin count := nullif(btrim(r->>'del_qty'),'')::numeric; exception when others then count := null; end;
  if count is not null and count>=0 and count<=qty and trunc(count)=count then return to_jsonb(count); end if;
  return to_jsonb(case when done then qty else 0 end);
end;
$$;
revoke all on function public.cd_data_delivery_value(jsonb) from public,anon,authenticated;
grant execute on function public.cd_data_delivery_value(jsonb) to service_role;

create or replace function public.cd_data_preview(cid uuid)
returns table (row_index integer, base jsonb, mine jsonb, original jsonb, fields jsonb, conflict boolean)
language sql stable set search_path = '' as $$
  select d.row_index, r.data || b.v, r.data || d.values, r.data || o.v,
    (case when x.mine_delivery and x.different_delivery then '["del_qty","del_status"]'::jsonb else '[]'::jsonb end)
    || (case when x.mine_note and x.different_note then '["delivery_notes"]'::jsonb else '[]'::jsonb end),
    (x.mine_delivery and x.team_delivery and x.different_delivery)
      or (x.mine_note and x.team_note and x.different_note)
  from public.cd_data_copies c join public.cd_data_files f on f.id=c.file_id
  join public.cd_data_drafts d on d.copy_id=c.id
  join public.cd_data_records r on r.file_id=c.file_id and r.row_index=d.row_index
  cross join lateral (select public.cd_data_at(f.id,r.row_index,c.base_revision,r.data) v) b
  cross join lateral (select public.cd_data_at(f.id,r.row_index,f.revision,r.data) v) o
  cross join lateral (select public.cd_data_delivery_value(r.data || b.v) bd,
    public.cd_data_delivery_value(r.data || d.values) md,
    public.cd_data_delivery_value(r.data || o.v) od,
    coalesce(b.v->>'delivery_notes','') bn, coalesce(d.values->>'delivery_notes','') mn,
    coalesce(o.v->>'delivery_notes','') onote) v
  cross join lateral (select v.bd is distinct from v.md mine_delivery,
    v.bd is distinct from v.od team_delivery, v.md is distinct from v.od different_delivery,
    v.bn <> v.mn mine_note, v.bn <> v.onote team_note, v.mn <> v.onote different_note) x
  where c.id=cid;
$$;

commit;
