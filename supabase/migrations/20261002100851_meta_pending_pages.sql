-- Exported read-only from supabase_migrations.schema_migrations (20261002100851) on 2026-10-05
create table if not exists public.meta_pending_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cubicle_id uuid not null references public.cubicles(id) on delete cascade,
  page_id text not null,
  page_name text,
  page_token text not null,
  ig_id text,
  ig_username text,
  created_at timestamptz not null default now()
);
create index if not exists meta_pending_pages_cubicle_idx on public.meta_pending_pages(cubicle_id);
alter table public.meta_pending_pages enable row level security;
-- No policies on purpose: page tokens are only ever read/written by edge functions using the service role.
comment on table public.meta_pending_pages is 'Short-lived list of Facebook Pages granted during OAuth, waiting for the user to pick which Page belongs to a cubicle. Service-role only.';
