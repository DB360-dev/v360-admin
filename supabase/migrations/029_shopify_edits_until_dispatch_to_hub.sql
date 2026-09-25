-- Shopify edits (address, phone, items, totals, COD, notes) now apply to an
-- order at any stage before "Dispatched to hub" (including brand confirmed,
-- confirmed and brand preparing). Once dispatched to the hub, the order is
-- frozen: the change is only logged on the order timeline.
-- The no-op fingerprint now covers email, phone and note attributes, so
-- edits to only those fields are no longer dropped as "unchanged".
-- Cancellation handling is unchanged.

create or replace function ingest_shopify_order(p_brand_id uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sa jsonb := p_payload->'shipping_address';
  v_country text := upper(coalesce(sa->>'country_code', ''));
  v_shopify_id bigint := (p_payload->>'id')::bigint;
  v_hash text;
  v_existing orders%rowtype;
  v_order_id uuid;
  v_financial text := p_payload->>'financial_status';
  v_presentment_total numeric := coalesce(
      (p_payload#>>'{total_price_set,presentment_money,amount}')::numeric,
      (p_payload->>'total_price')::numeric);
  v_presentment_currency text := coalesce(
      p_payload#>>'{total_price_set,presentment_money,currency_code}',
      p_payload->>'presentment_currency', p_payload->>'currency');
  v_notes text;
begin
  if v_country <> 'BD' then
    return jsonb_build_object('action', 'skipped', 'reason', 'country ' || coalesce(nullif(v_country, ''), 'missing'));
  end if;

  -- Fingerprint of the fields we care about, to ignore no-op webhooks.
  -- Includes every field applied below (email, phone, note attributes too).
  v_hash := md5(concat_ws('|', sa::text, p_payload->>'total_price', p_payload->>'financial_status',
                          p_payload->>'cancelled_at', p_payload->>'note', (p_payload->'line_items')::text,
                          p_payload->>'email', p_payload->>'phone', p_payload#>>'{customer,phone}',
                          (p_payload->'note_attributes')::text, p_payload->>'subtotal_price',
                          p_payload->>'total_discounts'));

  select string_agg((a->>'name') || ': ' || (a->>'value'), E'\n') into v_notes
  from jsonb_array_elements(coalesce(p_payload->'note_attributes', '[]'::jsonb)) a;

  select * into v_existing from orders
  where brand_id = p_brand_id and shopify_order_id = v_shopify_id for update;

  if not found then
    insert into orders (
      brand_id, shopify_order_id, order_number, order_date,
      customer_name, customer_phone, customer_email,
      address1, address2, city, province, zip, country_code,
      currency, subtotal, discount_total, shipping_total, order_total, payment_status,
      cod_amount_expected, cod_currency, customer_note, shopify_note, shopify_payload_hash
    ) values (
      p_brand_id, v_shopify_id, coalesce(p_payload->>'name', '#' || (p_payload->>'order_number')),
      coalesce((p_payload->>'created_at')::timestamptz, now()),
      coalesce(sa->>'name', trim(concat_ws(' ', sa->>'first_name', sa->>'last_name'))),
      coalesce(sa->>'phone', p_payload->>'phone', p_payload#>>'{customer,phone}'),
      coalesce(p_payload->>'email', p_payload#>>'{customer,email}'),
      sa->>'address1', sa->>'address2', sa->>'city', sa->>'province', sa->>'zip', v_country,
      coalesce(p_payload->>'currency', 'PKR'),
      coalesce((p_payload->>'subtotal_price')::numeric, 0),
      coalesce((p_payload->>'total_discounts')::numeric, 0),
      coalesce((p_payload#>>'{total_shipping_price_set,shop_money,amount}')::numeric, 0),
      coalesce((p_payload->>'total_price')::numeric, 0),
      v_financial,
      case when v_financial in ('paid', 'refunded') then 0 else v_presentment_total end,
      v_presentment_currency,
      p_payload->>'note', v_notes, v_hash
    ) returning id into v_order_id;

    insert into order_items (order_id, shopify_line_item_id, product_name, sku, variant, quantity, unit_price, discount)
    select v_order_id, (li->>'id')::bigint, coalesce(li->>'title', li->>'name'), nullif(li->>'sku', ''),
           nullif(li->>'variant_title', ''), (li->>'quantity')::int,
           coalesce((li->>'price')::numeric, 0), coalesce((li->>'total_discount')::numeric, 0)
    from jsonb_array_elements(coalesce(p_payload->'line_items', '[]'::jsonb)) li
    where (li->>'quantity')::int > 0;

    insert into order_events (order_id, actor_label, action, to_status)
    values (v_order_id, 'Shopify', 'Imported from Shopify', 'new');

    -- An order can arrive already cancelled (e.g. replayed webhook)
    if p_payload->>'cancelled_at' is not null then
      update orders set shopify_cancelled_at = (p_payload->>'cancelled_at')::timestamptz where id = v_order_id;
      perform _set_order_status(v_order_id, 'cancelled', 'Cancelled in Shopify', null, 'Shopify');
    end if;
    return jsonb_build_object('action', 'created', 'order_id', v_order_id);
  end if;

  v_order_id := v_existing.id;

  if v_existing.shopify_payload_hash = v_hash then
    return jsonb_build_object('action', 'unchanged', 'order_id', v_order_id);
  end if;

  update orders set shopify_payload_hash = v_hash, payment_status = v_financial where id = v_order_id;

  -- Cancellation in Shopify
  if p_payload->>'cancelled_at' is not null and v_existing.shopify_cancelled_at is null then
    update orders set shopify_cancelled_at = (p_payload->>'cancelled_at')::timestamptz where id = v_order_id;
    if v_existing.status in ('new','confirmation_pending','customer_unreachable','needs_amendment','confirmed','brand_preparing') then
      perform _set_order_status(v_order_id, 'cancelled', 'Cancelled in Shopify', null, 'Shopify');
    elsif not status_is_terminal(v_existing.status) and v_existing.status <> 'hold' then
      perform _set_order_status(v_order_id, 'hold', 'Cancelled in Shopify after dispatch',
        'V360 to decide: stop, return, or deliver anyway', 'Shopify');
    else
      perform _log_order_event(v_order_id, 'Cancelled in Shopify', 'Order was already ' || v_existing.status, 'Shopify');
    end if;
    return jsonb_build_object('action', 'cancelled', 'order_id', v_order_id);
  end if;

  -- Edits: apply until the brand dispatches the order to the hub. From then on
  -- (including orders put on hold from those later stages) the order is frozen.
  if v_existing.status in ('new','confirmation_pending','customer_unreachable','needs_amendment','brand_confirmed','confirmed','brand_preparing')
     or (v_existing.status = 'hold' and v_existing.previous_status in ('new','confirmation_pending','customer_unreachable','needs_amendment','brand_confirmed','confirmed','brand_preparing')) then
    update orders set
      customer_name  = coalesce(sa->>'name', customer_name),
      customer_phone = coalesce(sa->>'phone', p_payload->>'phone', customer_phone),
      customer_email = coalesce(p_payload->>'email', customer_email),
      address1 = sa->>'address1', address2 = sa->>'address2', city = sa->>'city',
      province = sa->>'province', zip = sa->>'zip',
      subtotal = coalesce((p_payload->>'subtotal_price')::numeric, subtotal),
      discount_total = coalesce((p_payload->>'total_discounts')::numeric, discount_total),
      order_total = coalesce((p_payload->>'total_price')::numeric, order_total),
      cod_amount_expected = case when v_financial in ('paid','refunded') then 0 else v_presentment_total end,
      customer_note = p_payload->>'note', shopify_note = v_notes
    where id = v_order_id;

    insert into order_items (order_id, shopify_line_item_id, product_name, sku, variant, quantity, unit_price, discount)
    select v_order_id, (li->>'id')::bigint, coalesce(li->>'title', li->>'name'), nullif(li->>'sku', ''),
           nullif(li->>'variant_title', ''), (li->>'quantity')::int,
           coalesce((li->>'price')::numeric, 0), coalesce((li->>'total_discount')::numeric, 0)
    from jsonb_array_elements(coalesce(p_payload->'line_items', '[]'::jsonb)) li
    where (li->>'quantity')::int > 0
    on conflict (order_id, shopify_line_item_id) do update set
      product_name = excluded.product_name, sku = excluded.sku, variant = excluded.variant,
      quantity = excluded.quantity, unit_price = excluded.unit_price, discount = excluded.discount;

    delete from order_items i where i.order_id = v_order_id
      and i.shopify_line_item_id not in (
        select (li->>'id')::bigint from jsonb_array_elements(coalesce(p_payload->'line_items','[]'::jsonb)) li
        where (li->>'quantity')::int > 0);

    perform _log_order_event(v_order_id, 'Updated from Shopify',
      case when v_existing.status not in ('new','confirmation_pending','customer_unreachable','needs_amendment')
           then 'Order was already ' || v_existing.status end,
      'Shopify');
    return jsonb_build_object('action', 'updated', 'order_id', v_order_id);
  end if;

  perform _log_order_event(v_order_id, 'Order changed in Shopify after dispatch to hub — not applied',
    'Check the Shopify order and edit here if needed', 'Shopify');
  return jsonb_build_object('action', 'flagged', 'order_id', v_order_id);
end $$;
