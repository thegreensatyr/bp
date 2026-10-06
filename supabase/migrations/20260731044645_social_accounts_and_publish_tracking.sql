-- Exported read-only from supabase_migrations.schema_migrations (20260731044645) on 2026-10-05

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cubicle_id uuid not null references public.cubicles(id) on delete cascade,
  platform text not null check (platform in ('facebook','instagram')),
  external_account_id text not null,
  external_account_name text default '',
  access_token text not null,
  token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  unique (cubicle_id, platform)
);

alter table public.social_accounts enable row level security;

create policy "Users can view own social accounts"
  on public.social_accounts for select
  using (auth.uid() = user_id);

create policy "Users can insert own social accounts"
  on public.social_accounts for insert
  with check (auth.uid() = user_id);

create policy "Users can update own social accounts"
  on public.social_accounts for update
  using (auth.uid() = user_id);

create policy "Users can delete own social accounts"
  on public.social_accounts for delete
  using (auth.uid() = user_id);

alter table public.drafts add column if not exists published_at timestamptz;
alter table public.drafts add column if not exists platform_post_id text;
alter table public.drafts add column if not exists publish_error text;
alter table public.drafts add column if not exists social_account_id uuid references public.social_accounts(id) on delete set null;

create index social_accounts_cubicle_id_idx on public.social_accounts(cubicle_id);
create index social_accounts_user_id_idx on public.social_accounts(user_id);
