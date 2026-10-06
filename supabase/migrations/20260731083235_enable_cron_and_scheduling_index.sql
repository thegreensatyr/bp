-- Exported read-only from supabase_migrations.schema_migrations (20260731083235) on 2026-10-05
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE INDEX IF NOT EXISTS idx_drafts_status_scheduled_for ON drafts(status, scheduled_for) WHERE status = 'scheduled';
