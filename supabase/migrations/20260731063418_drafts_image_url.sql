-- Exported read-only from supabase_migrations.schema_migrations (20260731063418) on 2026-10-05

alter table public.drafts add column if not exists image_url text;
