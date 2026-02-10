-- Slack alerting for dead/failed jobs.
-- Requires: ALTER DATABASE postgres SET app.settings.slack_webhook_url = 'https://hooks.slack.com/services/...';

create or replace function integrations.notify_dead_jobs()
returns void
language plpgsql
security definer
set search_path = integrations, net, public
as $$
declare
  dead_count integer;
  failed_count integer;
  alert_url text;
  message_text text;
begin
  select count(*) into dead_count
  from integrations.jobs
  where status = 'dead'
    and updated_at > now() - interval '10 minutes';

  select count(*) into failed_count
  from integrations.jobs
  where status = 'failed'
    and updated_at > now() - interval '10 minutes';

  if dead_count = 0 and failed_count = 0 then
    return;
  end if;

  alert_url := current_setting('app.settings.slack_webhook_url', true);
  if alert_url is null or alert_url = '' then
    raise warning 'app.settings.slack_webhook_url not configured, skipping alert';
    return;
  end if;

  message_text := format(
    ':rotating_light: *Alerta Jobs MaisFloreta* - %s dead, %s failed nos ultimos 10 min | %s',
    dead_count, failed_count, to_char(now(), 'DD/MM HH24:MI')
  );

  perform net.http_post(
    alert_url,
    jsonb_build_object('text', message_text),
    '{}'::jsonb,
    '{"Content-Type": "application/json"}'::jsonb,
    5000
  );
end;
$$;

grant execute on function integrations.notify_dead_jobs() to postgres;

-- Check for dead jobs every 5 minutes
select cron.schedule(
  'check-dead-jobs',
  '*/5 * * * *',
  $$ select integrations.notify_dead_jobs(); $$
);
