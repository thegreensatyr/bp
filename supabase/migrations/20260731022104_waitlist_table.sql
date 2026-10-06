-- Exported read-only from supabase_migrations.schema_migrations (20260731022104) on 2026-10-05

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

-- Anyone (even signed-out visitors) can join the waitlist, but cannot read who else is on it.
create policy "Anyone can join waitlist"
  on public.waitlist for insert
  with check (true);
