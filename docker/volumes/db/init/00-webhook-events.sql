create extension if not exists pgcrypto;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('yampi', 'cartpanda', 'unknown')),
  event_name text,
  external_event_id text,
  external_order_id text,
  signature text,
  source_ip inet,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb,
  raw_body text,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'error')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists webhook_events_provider_event_unique_idx
  on public.webhook_events (provider, external_event_id)
  where external_event_id is not null;

create index if not exists webhook_events_provider_received_at_idx
  on public.webhook_events (provider, received_at desc);

create index if not exists webhook_events_external_order_id_idx
  on public.webhook_events (external_order_id);

alter table public.webhook_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'webhook_events'
      and policyname = 'service_role_full_access_webhook_events'
  ) then
    create policy service_role_full_access_webhook_events
      on public.webhook_events
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

revoke all on public.webhook_events from anon, authenticated;
grant select, insert, update on public.webhook_events to service_role;
