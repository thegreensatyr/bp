-- Exported read-only from supabase_migrations.schema_migrations (20260907143345) on 2026-10-05
-- Replace the unconditional "with check (true)" on the public waitlist INSERT
-- policy with an actual email-shape check, so unauthenticated signup still
-- works with no login required, but junk/garbage rows can't be inserted.
drop policy if exists "Anyone can join waitlist" on public.waitlist;
create policy "Anyone can join waitlist" on public.waitlist
  for insert
  to public
  with check (
    email is not null
    and length(email) between 5 and 254
    and email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  );
