-- Enable pg_cron extension for scheduled jobs
create extension if not exists pg_cron schema extensions;

-- Grant postgres access to the cron schema
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Schedule jobs-runner to run every 2 minutes to pick up retries and orphaned jobs.
-- Uses pg_net to call the Edge Function via the internal Kong gateway.
-- The WEBHOOK_SHARED_TOKEN must be configured as a PostgreSQL custom setting:
--   ALTER DATABASE postgres SET app.settings.webhook_shared_token = '<token>';
--   ALTER DATABASE postgres SET app.settings.supabase_url = 'http://kong:8000';
select cron.schedule(
  'trigger-jobs-runner',
  '*/2 * * * *',
  $$
  select net.http_post(
    'http://kong:8000/functions/v1/jobs-runner',
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-shared-token', current_setting('app.settings.webhook_shared_token', true)
    ),
    5000
  );
  $$
);

-- Cleanup: archive old completed jobs (older than 90 days) every day at 4 AM
select cron.schedule(
  'cleanup-old-jobs',
  '0 4 * * *',
  $$
  delete from integrations.jobs
  where status in ('done', 'dead')
    and updated_at < now() - interval '90 days';

  delete from integrations.integration_events
  where status in ('processed', 'failed')
    and received_at < now() - interval '90 days'
    and id not in (select event_id from integrations.jobs where event_id is not null);
  $$
);
