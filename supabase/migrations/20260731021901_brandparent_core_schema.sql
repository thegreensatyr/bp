-- Exported read-only from supabase_migrations.schema_migrations (20260731021901) on 2026-10-05

-- Profiles: one row per user, holds the "parent identity" info
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  parent_name text default 'My Identity',
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Auto-create a profile row whenever a new user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, parent_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'parent_name', 'My Identity'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Cubicles: each brand identity a user runs
create table public.cubicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  role text default '',
  audience text default '',
  tone text default '',
  icon_initials text default '',
  color text default '#6B5B95',
  signature_phrases text[] not null default '{}',
  lexicon text[] not null default '{}',
  never_says text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cubicles enable row level security;

create policy "Users can view own cubicles"
  on public.cubicles for select
  using (auth.uid() = user_id);

create policy "Users can insert own cubicles"
  on public.cubicles for insert
  with check (auth.uid() = user_id);

create policy "Users can update own cubicles"
  on public.cubicles for update
  using (auth.uid() = user_id);

create policy "Users can delete own cubicles"
  on public.cubicles for delete
  using (auth.uid() = user_id);

-- Drafts: posts/captions written inside a cubicle
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cubicle_id uuid not null references public.cubicles(id) on delete cascade,
  content text not null default '',
  optimized_caption text,
  bleed_check_flags jsonb not null default '[]'::jsonb,
  bleed_check_clean boolean not null default true,
  status text not null default 'draft' check (status in ('draft','scheduled','published')),
  scheduled_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.drafts enable row level security;

create policy "Users can view own drafts"
  on public.drafts for select
  using (auth.uid() = user_id);

create policy "Users can insert own drafts"
  on public.drafts for insert
  with check (auth.uid() = user_id);

create policy "Users can update own drafts"
  on public.drafts for update
  using (auth.uid() = user_id);

create policy "Users can delete own drafts"
  on public.drafts for delete
  using (auth.uid() = user_id);

-- updated_at maintenance
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cubicles_set_updated_at before update on public.cubicles
  for each row execute procedure public.set_updated_at();

create trigger drafts_set_updated_at before update on public.drafts
  for each row execute procedure public.set_updated_at();

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();

create index drafts_cubicle_id_idx on public.drafts(cubicle_id);
create index cubicles_user_id_idx on public.cubicles(user_id);
create index drafts_user_id_idx on public.drafts(user_id);
