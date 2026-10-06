-- Exported read-only from supabase_migrations.schema_migrations (20260923080839) on 2026-10-05
alter table public.social_accounts
  add column if not exists refresh_token text,
  add column if not exists refresh_expires_at timestamptz;
alter table public.drafts
  add column if not exists platform_options jsonb;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tiktok-media', 'tiktok-media', true, 20971520, array['image/jpeg','image/webp','video/mp4','text/plain'])
on conflict (id) do nothing;
