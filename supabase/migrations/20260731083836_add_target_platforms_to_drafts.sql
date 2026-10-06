-- Exported read-only from supabase_migrations.schema_migrations (20260731083836) on 2026-10-05
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS target_platforms text[];
