-- Exported read-only from supabase_migrations.schema_migrations (20260922203235) on 2026-10-05
alter table public.cubicles
  add column if not exists background_image_url text,
  add column if not exists background_overlay smallint not null default 55 check (background_overlay between 0 and 95);
