-- Exported read-only from supabase_migrations.schema_migrations (20260822231436) on 2026-10-05
alter table public.cubicles
  add column if not exists background_color text not null default '#faf7f2',
  add column if not exists text_color text not null default '#1c1b2e';

alter table public.profiles
  add column if not exists tutorials_enabled boolean not null default true;
