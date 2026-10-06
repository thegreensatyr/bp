-- Exported read-only from supabase_migrations.schema_migrations (20260816025741) on 2026-10-05
-- Fix auth_rls_initplan performance warnings: wrap auth.uid() in a subquery
-- so Postgres evaluates it once per query instead of once per row.
-- Semantics unchanged, only wrapped for the query planner.

-- profiles
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles
  for select using ((select auth.uid()) = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update using ((select auth.uid()) = id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile" on public.profiles
  for insert with check ((select auth.uid()) = id);

-- cubicles
drop policy if exists "Users can view own cubicles" on public.cubicles;
create policy "Users can view own cubicles" on public.cubicles
  for select using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own cubicles" on public.cubicles;
create policy "Users can insert own cubicles" on public.cubicles
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own cubicles" on public.cubicles;
create policy "Users can update own cubicles" on public.cubicles
  for update using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own cubicles" on public.cubicles;
create policy "Users can delete own cubicles" on public.cubicles
  for delete using ((select auth.uid()) = user_id);

-- drafts
drop policy if exists "Users can view own drafts" on public.drafts;
create policy "Users can view own drafts" on public.drafts
  for select using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own drafts" on public.drafts;
create policy "Users can insert own drafts" on public.drafts
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own drafts" on public.drafts;
create policy "Users can update own drafts" on public.drafts
  for update using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own drafts" on public.drafts;
create policy "Users can delete own drafts" on public.drafts
  for delete using ((select auth.uid()) = user_id);

-- social_accounts
drop policy if exists "Users can view own social accounts" on public.social_accounts;
create policy "Users can view own social accounts" on public.social_accounts
  for select using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own social accounts" on public.social_accounts;
create policy "Users can insert own social accounts" on public.social_accounts
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own social accounts" on public.social_accounts;
create policy "Users can update own social accounts" on public.social_accounts
  for update using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own social accounts" on public.social_accounts;
create policy "Users can delete own social accounts" on public.social_accounts
  for delete using ((select auth.uid()) = user_id);
