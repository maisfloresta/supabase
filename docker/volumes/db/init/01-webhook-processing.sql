create or replace function public.parse_money_to_cents(value_text text)
returns bigint
language plpgsql
as $$
declare
  cleaned text;
  num numeric;
begin
  if value_text is null or btrim(value_text) = '' then
    return null;
  end if;

  cleaned := regexp_replace(value_text, '[^0-9,.\-]', '', 'g');
  if cleaned = '' then
    return null;
  end if;

  -- If comma is present, treat comma as decimal separator.
  if position(',' in cleaned) > 0 then
    cleaned := replace(replace(cleaned, '.', ''), ',', '.');
    num := cleaned::numeric;
    return round(num * 100)::bigint;
  end if;

  num := cleaned::numeric;
  if cleaned ~ '^\-?\d+$' then
    -- Heuristic: integer >= 1000 is likely already cents.
    if abs(num) >= 1000 then
      return num::bigint;
    end if;
  end if;

  return round(num * 100)::bigint;
exception
  when others then
    return null;
end;
$$;

create or replace function public.process_webhook_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_event public.webhook_events%rowtype;
  v_payload jsonb;
  v_order jsonb;
  v_items jsonb;
  v_item jsonb;
  v_provider text;
  v_external_order_id text;
  v_external_order_number text;
  v_event_name text;
  v_status text;
  v_currency text;
  v_total_cents bigint;
  v_existing_order_id uuid;
  v_order_id uuid;
  v_prev_status text;
  v_system_user_id uuid := '00000000-0000-0000-0000-000000000111';
  v_system_email text := 'webhook-ingest@local.internal';
  v_description text;
  v_external_product_id text;
  v_product_id uuid;
  v_product_name text;
  v_unit_price_cents bigint;
  v_quantity integer;
begin
  select *
    into v_event
  from public.webhook_events
  where id = p_event_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  v_payload := coalesce(v_event.payload, '{}'::jsonb);
  v_provider := coalesce(v_event.provider, 'unknown');
  v_event_name := coalesce(v_event.event_name, '');
  v_order := coalesce(v_payload -> 'order', v_payload);
  if v_provider = 'yampi' and jsonb_typeof(v_payload -> 'resource') = 'object' then
    v_order := v_payload -> 'resource';
  end if;

  v_external_order_id := nullif(
    coalesce(
      v_order ->> 'id',
      v_order ->> 'order_id',
      v_payload #>> '{resource,id}',
      v_payload ->> 'order_id',
      v_payload ->> 'checkout_id',
      v_event.external_order_id
    ),
    ''
  );

  if v_external_order_id is null then
    update public.webhook_events
      set status = 'ignored',
          error_message = 'missing external order id',
          processed_at = now()
    where id = p_event_id;

    return jsonb_build_object('ok', false, 'ignored', true, 'reason', 'missing_external_order_id');
  end if;

  v_external_order_number := nullif(
    coalesce(v_order ->> 'number', v_order ->> 'order_number', v_payload #>> '{resource,number}', v_payload ->> 'order_number'),
    ''
  );

  v_status := lower(coalesce(v_order #>> '{status,data,alias}', v_order ->> 'status', v_payload ->> 'status', 'received'));
  if v_status = '' then
    v_status := 'received';
  end if;

  if v_status in ('paid', 'approved', 'authorized') or v_event_name like '%paid%' then
    v_status := 'paid';
  elsif v_status in ('cancelled', 'canceled', 'voided') then
    v_status := 'cancelled';
  elsif v_status in ('refunded', 'chargeback') then
    v_status := 'refunded';
  elsif v_status in ('shipped', 'fulfilled') then
    v_status := 'shipped';
  elsif v_status in ('pending', 'waiting_payment', 'awaiting_payment') then
    v_status := 'pending';
  end if;

  v_currency := upper(coalesce(v_order ->> 'currency', v_payload ->> 'currency', 'BRL'));

  v_total_cents := coalesce(
    case when nullif(v_order ->> 'total', '') is not null then public.parse_money_to_cents(v_order ->> 'total') end,
    case when nullif(v_order ->> 'total_amount', '') is not null then public.parse_money_to_cents(v_order ->> 'total_amount') end,
    case when nullif(v_order ->> 'amount', '') is not null then public.parse_money_to_cents(v_order ->> 'amount') end,
    case when nullif(v_order ->> 'value_total', '') is not null then public.parse_money_to_cents(v_order ->> 'value_total') end,
    case when nullif(v_payload #>> '{resource,value_total}', '') is not null then public.parse_money_to_cents(v_payload #>> '{resource,value_total}') end,
    case when nullif(v_payload ->> 'total', '') is not null then public.parse_money_to_cents(v_payload ->> 'total') end,
    0
  );

  insert into auth.users (
    id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  values (
    v_system_user_id,
    'authenticated',
    'authenticated',
    v_system_email,
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"source":"webhook_ingest"}'::jsonb,
    now(),
    now()
  )
  on conflict (id) do nothing;

  insert into public.profiles (id, name, is_admin, total_spent_cents, created_at, updated_at)
  values (v_system_user_id, 'Webhook Ingest', false, 0, now(), now())
  on conflict (id) do update
    set updated_at = now();

  select os.order_id
    into v_existing_order_id
  from public.order_sources os
  where os.source = v_provider
    and os.external_order_id = v_external_order_id
  limit 1;

  if v_existing_order_id is null then
    insert into public.orders (user_id, status, total_cents, currency, created_at, updated_at)
    values (v_system_user_id, v_status, coalesce(v_total_cents, 0), v_currency, now(), now())
    returning id into v_order_id;

    insert into public.order_sources (
      order_id, source, external_order_id, external_order_number, payload, created_at
    )
    values (
      v_order_id, v_provider, v_external_order_id, v_external_order_number, v_payload, now()
    );
  else
    v_order_id := v_existing_order_id;
    select o.status into v_prev_status from public.orders o where o.id = v_order_id;

    update public.orders
      set status = v_status,
          total_cents = case when v_total_cents is null or v_total_cents = 0 then total_cents else v_total_cents end,
          currency = coalesce(v_currency, currency),
          updated_at = now()
    where id = v_order_id;

    update public.order_sources
      set payload = v_payload,
          external_order_number = coalesce(v_external_order_number, external_order_number)
    where source = v_provider and external_order_id = v_external_order_id;

    if v_prev_status is distinct from v_status then
      insert into public.order_status_history (order_id, status, description, created_at)
      values (v_order_id, v_status, 'status changed from webhook', now());
    end if;

    delete from public.order_items where order_id = v_order_id;
  end if;

  v_items := coalesce(v_order -> 'items', v_payload -> 'items', '[]'::jsonb);
  if jsonb_typeof(v_items) = 'object' and jsonb_typeof(v_items -> 'data') = 'array' then
    v_items := v_items -> 'data';
  end if;
  if jsonb_typeof(v_items) = 'array' then
    for v_item in select value from jsonb_array_elements(v_items)
    loop
      v_product_name := coalesce(
        nullif(v_item ->> 'name', ''),
        nullif(v_item ->> 'title', ''),
        nullif(v_item ->> 'product_name', ''),
        nullif(v_item #>> '{sku,data,title}', ''),
        'Produto'
      );
      v_quantity := coalesce(nullif(v_item ->> 'quantity', '')::integer, 1);

      v_unit_price_cents := coalesce(
        case when nullif(v_item ->> 'price', '') is not null then public.parse_money_to_cents(v_item ->> 'price') end,
        case when nullif(v_item ->> 'unit_price', '') is not null then public.parse_money_to_cents(v_item ->> 'unit_price') end,
        case when nullif(v_item ->> 'amount', '') is not null then public.parse_money_to_cents(v_item ->> 'amount') end,
        case when nullif(v_item #>> '{sku,data,price_sale}', '') is not null then public.parse_money_to_cents(v_item #>> '{sku,data,price_sale}') end,
        0
      );

      v_external_product_id := nullif(
        coalesce(v_item ->> 'product_id', v_item ->> 'id', v_item ->> 'sku'),
        ''
      );

      v_product_id := null;
      if v_external_product_id is not null then
        select ps.product_id
          into v_product_id
        from public.product_sources ps
        where ps.source = v_provider
          and ps.external_product_id = v_external_product_id
        limit 1;

        if v_product_id is null then
          insert into public.products (name, price_cents, active, created_at, updated_at)
          values (v_product_name, coalesce(v_unit_price_cents, 0), true, now(), now())
          returning id into v_product_id;

          insert into public.product_sources (product_id, source, external_product_id, payload, created_at)
          values (v_product_id, v_provider, v_external_product_id, v_item, now());
        else
          update public.products
            set name = coalesce(v_product_name, name),
                price_cents = case when coalesce(v_unit_price_cents, 0) > 0 then v_unit_price_cents else price_cents end,
                updated_at = now()
          where id = v_product_id;
        end if;
      end if;

      insert into public.order_items (
        order_id, product_id, product_name_snapshot, unit_price_cents, quantity, created_at
      )
      values (
        v_order_id, v_product_id, v_product_name, coalesce(v_unit_price_cents, 0), greatest(coalesce(v_quantity, 1), 1), now()
      );
    end loop;
  end if;

  v_description := format('processed webhook %s (%s)', coalesce(v_event.external_event_id, p_event_id::text), v_event_name);
  insert into public.order_status_history (order_id, status, description, created_at)
  values (v_order_id, v_status, v_description, now());

  update public.webhook_events
    set status = 'processed',
        error_message = null,
        processed_at = now()
  where id = p_event_id;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'external_order_id', v_external_order_id,
    'provider', v_provider
  );
exception
  when others then
    update public.webhook_events
      set status = 'error',
          error_message = left(sqlerrm, 1000),
          processed_at = now()
    where id = p_event_id;

    return jsonb_build_object('ok', false, 'error', sqlerrm, 'event_id', p_event_id);
end;
$$;

revoke all on function public.parse_money_to_cents(text) from public;
grant execute on function public.parse_money_to_cents(text) to service_role;

revoke all on function public.process_webhook_event(uuid) from public;
grant execute on function public.process_webhook_event(uuid) to service_role;
