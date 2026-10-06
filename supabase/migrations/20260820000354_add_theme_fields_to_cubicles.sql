-- Exported read-only from supabase_migrations.schema_migrations (20260820000354) on 2026-10-05

alter table public.cubicles
  add column if not exists secondary_color text not null default '#c9c6d3',
  add column if not exists font_heading text not null default 'Fraunces',
  add column if not exists font_body text not null default 'Inter';
