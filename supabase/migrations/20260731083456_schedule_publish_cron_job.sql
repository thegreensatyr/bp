-- Exported read-only from supabase_migrations.schema_migrations (20260731083456) on 2026-10-05
SELECT cron.schedule(
  'publish-scheduled-posts',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://owxaolqikmgtlegtficq.supabase.co/functions/v1/cron-publish-scheduled',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_publish_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
