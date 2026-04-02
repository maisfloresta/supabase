alter table public.quiz_orders
  add column if not exists logistics_webhook_claim_token text,
  add column if not exists logistics_webhook_claimed_at timestamp with time zone,
  add column if not exists logistics_webhook_sent_at timestamp with time zone,
  add column if not exists logistics_webhook_last_error text;

create index if not exists quiz_orders_logistics_webhook_sent_at_idx
  on public.quiz_orders (logistics_webhook_sent_at);

create index if not exists quiz_orders_logistics_webhook_claimed_at_idx
  on public.quiz_orders (logistics_webhook_claimed_at);
