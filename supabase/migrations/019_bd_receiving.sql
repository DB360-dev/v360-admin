-- =====================================================================
-- 019_bd_receiving.sql — Physical item check when shipment arrives in BD.
-- Tracks per-item received quantities. Blocks advance to received_by_partner
-- until every item is checked and every discrepancy has a note.
-- =====================================================================

create table bd_received_items (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references shipments(id) on delete cascade,
  order_id      uuid not null references orders(id) on delete cascade,
  order_item_id uuid not null references order_items(id) on delete cascade,
  expected_qty  int not null,
  received_qty  int not null,
  note          text,
  checked_at    timestamptz not null default now(),
  checked_by    uuid references profiles(id),
  unique(shipment_id, order_item_id)
);

alter table bd_received_items enable row level security;

create policy bd_receiving_select on bd_received_items
  for select to authenticated
  using (is_v360() or is_partner());

create policy bd_receiving_write on bd_received_items
  for all to authenticated
  using (is_v360() or is_partner())
  with check (is_v360() or is_partner());

grant select, insert, update, delete on bd_received_items to authenticated;

-- ----------------------------------------------------------------
-- Upsert received quantities for one order's items.
-- ----------------------------------------------------------------
create function bd_save_order_receiving(
  p_shipment_id uuid,
  p_order_id    uuid,
  p_items       jsonb  -- [{order_item_id, received_qty, note}]
)
returns void language plpgsql security definer set search_path = public as $$
declare
  s     shipments%rowtype;
  item  jsonb;
  v_item_id   uuid;
  v_expected  int;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  select * into s from shipments where id = p_shipment_id;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status <> 'arrived_bd' then
    raise exception 'Receiving check is only available when the shipment has arrived in Bangladesh';
  end if;

  if not exists (select 1 from orders where id = p_order_id and shipment_id = p_shipment_id) then
    raise exception 'Order not in this shipment';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    v_item_id := (item->>'order_item_id')::uuid;
    select quantity into v_expected
    from order_items where id = v_item_id and order_id = p_order_id;
    if not found then raise exception 'Item not found in order'; end if;

    insert into bd_received_items
      (shipment_id, order_id, order_item_id, expected_qty, received_qty, note, checked_by)
    values
      (p_shipment_id, p_order_id, v_item_id, v_expected,
       coalesce((item->>'received_qty')::int, v_expected),
       nullif(trim(coalesce(item->>'note', '')), ''),
       auth.uid())
    on conflict (shipment_id, order_item_id) do update set
      received_qty = excluded.received_qty,
      note         = excluded.note,
      checked_at   = now(),
      checked_by   = excluded.checked_by;
  end loop;
end $$;

revoke execute on function bd_save_order_receiving(uuid, uuid, jsonb) from public;
grant execute on function bd_save_order_receiving(uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------
-- Validate all items checked + all discrepancies noted, then advance.
-- ----------------------------------------------------------------
create function bd_confirm_shipment_receiving(p_shipment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_unchecked   int;
  v_undisclosed int;
begin
  if not (is_v360() or is_partner()) then
    raise exception 'Not authorised';
  end if;

  select count(*) into v_unchecked
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.shipment_id = p_shipment_id
    and not exists (
      select 1 from bd_received_items r
      where r.shipment_id = p_shipment_id and r.order_item_id = oi.id
    );

  if v_unchecked > 0 then
    raise exception '% item(s) have not been checked yet', v_unchecked;
  end if;

  select count(*) into v_undisclosed
  from bd_received_items
  where shipment_id = p_shipment_id
    and received_qty <> expected_qty
    and (note is null or trim(note) = '');

  if v_undisclosed > 0 then
    raise exception '% discrepancy(s) need a note before confirming', v_undisclosed;
  end if;

  perform set_shipment_status(p_shipment_id, 'received_by_partner', 'BD receiving check completed');
end $$;

revoke execute on function bd_confirm_shipment_receiving(uuid) from public;
grant execute on function bd_confirm_shipment_receiving(uuid) to authenticated;
