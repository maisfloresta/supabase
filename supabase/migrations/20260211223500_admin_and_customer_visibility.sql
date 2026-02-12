create schema if not exists integrations;

create table if not exists integrations.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

grant usage on schema integrations to authenticated;
grant usage on schema integrations to service_role;
grant select, insert, delete on table integrations.app_admins to service_role;
grant select on table integrations.app_admins to authenticated;

alter table integrations.app_admins enable row level security;

drop policy if exists app_admins_self_select on integrations.app_admins;
create policy app_admins_self_select
on integrations.app_admins
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists app_admins_service_role_all on integrations.app_admins;
create policy app_admins_service_role_all
on integrations.app_admins
for all
to service_role
using (true)
with check (true);

create or replace function integrations.is_app_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = integrations, public
as $$
  select exists (
    select 1
    from integrations.app_admins aa
    where aa.user_id = coalesce(p_user_id, auth.uid())
  );
$$;

revoke all on function integrations.is_app_admin(uuid) from public;
grant execute on function integrations.is_app_admin(uuid) to authenticated;
grant execute on function integrations.is_app_admin(uuid) to service_role;

create or replace function public.list_my_orders(
  p_limit integer default 50,
  p_offset integer default 0,
  p_store_id uuid default null,
  p_source text default null,
  p_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  source text,
  store_id uuid,
  internal_order_id bigint,
  external_order_id text,
  order_number text,
  customer_name text,
  customer_email text,
  order_status text,
  payment_status text,
  total_cents integer,
  currency text,
  event_time timestamptz,
  ingested_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public, integrations, yampi, cartpanda
as $$
  with ctx as (
    select
      auth.uid() as user_id,
      lower((select u.email from auth.users u where u.id = auth.uid())) as user_email,
      integrations.is_app_admin(auth.uid()) as is_app_admin
  ),
  admin_store_access as (
    select sm.store_id
    from integrations.store_members sm
    join ctx on ctx.user_id = sm.user_id
    where sm.role in ('owner', 'admin')
  ),
  yampi_orders as (
    select
      'yampi'::text as source,
      ie.store_id,
      o.id as internal_order_id,
      o.yampi_order_id::text as external_order_id,
      o.order_number::text as order_number,
      coalesce(nullif(c.name, ''), nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')) as customer_name,
      c.email as customer_email,
      o.status_alias as order_status,
      o.payment_status,
      o.total_cents,
      o.currency,
      o.event_time,
      o.ingested_at,
      o.updated_at,
      coalesce(o.event_time, o.ingested_at) as sort_time
    from yampi.orders o
    join integrations.integration_events ie on ie.id = o.integration_event_id
    left join yampi.customers c on c.id = o.yampi_customer_ref_id
    cross join ctx
    where (p_store_id is null or ie.store_id = p_store_id)
      and (p_source is null or lower(p_source) = 'yampi')
      and (p_status is null or lower(coalesce(o.status_alias, '')) = lower(p_status))
      and (p_from is null or coalesce(o.event_time, o.ingested_at) >= p_from)
      and (p_to is null or coalesce(o.event_time, o.ingested_at) <= p_to)
      and (
        ctx.is_app_admin
        or ie.store_id in (select store_id from admin_store_access)
        or (ctx.user_email is not null and lower(coalesce(c.email, '')) = ctx.user_email)
      )
  ),
  cartpanda_orders as (
    select
      'cartpanda'::text as source,
      ie.store_id,
      o.id as internal_order_id,
      o.cartpanda_order_id::text as external_order_id,
      o.order_number,
      nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') as customer_name,
      coalesce(c.email, o.email) as customer_email,
      o.order_status,
      o.payment_status,
      o.total_cents,
      o.currency,
      o.event_time,
      o.ingested_at,
      o.updated_at,
      coalesce(o.event_time, o.ingested_at) as sort_time
    from cartpanda.orders o
    join integrations.integration_events ie on ie.id = o.integration_event_id
    left join cartpanda.customers c on c.id = o.customer_ref_id
    cross join ctx
    where (p_store_id is null or ie.store_id = p_store_id)
      and (p_source is null or lower(p_source) = 'cartpanda')
      and (p_status is null or lower(coalesce(o.order_status, '')) = lower(p_status))
      and (p_from is null or coalesce(o.event_time, o.ingested_at) >= p_from)
      and (p_to is null or coalesce(o.event_time, o.ingested_at) <= p_to)
      and (
        ctx.is_app_admin
        or ie.store_id in (select store_id from admin_store_access)
        or (
          ctx.user_email is not null
          and lower(coalesce(c.email, o.email, '')) = ctx.user_email
        )
      )
  )
  select
    orders.source,
    orders.store_id,
    orders.internal_order_id,
    orders.external_order_id,
    orders.order_number,
    orders.customer_name,
    orders.customer_email,
    orders.order_status,
    orders.payment_status,
    orders.total_cents,
    orders.currency,
    orders.event_time,
    orders.ingested_at,
    orders.updated_at
  from (
    select * from yampi_orders
    union all
    select * from cartpanda_orders
  ) orders
  order by orders.sort_time desc nulls last, orders.updated_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_my_orders(integer, integer, uuid, text, text, timestamptz, timestamptz) from public;
grant execute on function public.list_my_orders(integer, integer, uuid, text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.list_my_orders(integer, integer, uuid, text, text, timestamptz, timestamptz) to service_role;
