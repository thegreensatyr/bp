-- Exported read-only from supabase_migrations.schema_migrations (20260913220758) on 2026-10-05
alter table public.drafts add column if not exists video_url text;
