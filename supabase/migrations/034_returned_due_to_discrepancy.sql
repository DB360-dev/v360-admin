-- =====================================================================
-- 034_returned_due_to_discrepancy.sql
-- Orders auto-returned because KBB received less than was dispatched are
-- flagged, so every screen can show "Returned due to discrepancy".
-- =====================================================================

alter table orders add column if not exists returned_due_to_discrepancy boolean not null default false;

-- Backfill orders already auto-returned by 032.
update orders o set returned_due_to_discrepancy = true
where o.status = 'returned'
  and exists (select 1 from order_events e
              where e.order_id = o.id
                and e.action in ('Returned: items not received by KBB', 'Returned due to discrepancy'));

-- Same as 032, plus setting the flag.
create or replace function _auto_return_short_order(p_order_id uuid, p_shipment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  o         orders%rowtype;
  v_code    text := (select code from shipments where id = p_shipment_id);
  v_bd      int := 0;   -- units restocked in BD
  v_missing int := 0;   -- units still in Pakistan
begin
  select * into o from orders where id = p_order_id for update;
  if not found or o.status in ('returned', 'cancelled', 'delivered') then return; end if;

  -- Per line: BD units = received PK units + units the brand sent from BD stock.
  with lines as (
    select oi.id,
           oi.quantity,
           order_item_hub_qty(oi.quantity, oi.inventory_qty, oi.fulfilment_origin) as hub_qty,
           r.received_qty
    from order_items oi
    left join bd_received_items r on r.order_item_id = oi.id and r.shipment_id = p_shipment_id
    where oi.order_id = p_order_id
  ), calc as (
    select id,
           least(quantity, greatest(0, coalesce(received_qty, hub_qty)) + (quantity - hub_qty)) as bd_qty,
           greatest(0, hub_qty - coalesce(received_qty, hub_qty)) as missing_qty
    from lines
  ), upd as (
    update order_items oi set
      restock_qty        = c.bd_qty,
      return_disposition = case when c.bd_qty > 0 then 'restock_in_bd' else 'return_to_pk' end::return_disposition
    from calc c where oi.id = c.id
    returning c.bd_qty, c.missing_qty
  )
  select coalesce(sum(bd_qty), 0), coalesce(sum(missing_qty), 0) into v_bd, v_missing from upd;

  perform _set_order_status(p_order_id, 'returned', 'Returned due to discrepancy',
    'Shipment ' || v_code || ': ' || v_missing || ' unit(s) not received (still in Pakistan)');

  update orders set
    returned_due_to_discrepancy = true,
    return_disposition = case when v_bd > 0 then 'restock_in_bd' else 'return_to_pk' end::return_disposition
  where id = p_order_id;

  perform _log_order_event(p_order_id, 'Return disposition saved',
    'Automatic: ' || v_bd || ' unit(s) restocked in Bangladesh, '
    || v_missing || ' unit(s) not received — still in the Pakistan warehouse');
end $$;


-- Expose the flag on order_overview. The live view differs from the repo,
-- so append the column to its current definition instead of replacing it.
do $$
declare
  v_def text := pg_get_viewdef('order_overview'::regclass, true);
  v_pos int;
begin
  if v_def ~ 'returned_due_to_discrepancy' then return; end if;
  v_pos := strpos(v_def, E'\n   FROM ');
  if v_pos = 0 then
    raise exception 'order_overview: could not find its FROM clause. Definition: %', v_def;
  end if;
  execute 'create or replace view order_overview with (security_invoker = true) as '
    || substr(v_def, 1, v_pos - 1) || E',\n    o.returned_due_to_discrepancy' || substr(v_def, v_pos);
end $$;
