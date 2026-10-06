-- NOT YET APPLIED. Optional but recommended hardening (separate from the
-- token-column migration so it can be reviewed on its own).
--
-- 1) drafts: the INSERT/UPDATE policies only checked user_id = auth.uid(), so a
--    signed-in user could create a draft whose cubicle_id is SOMEONE ELSE's
--    cubicle. The publishers then loaded social accounts by cubicle_id alone,
--    i.e. could post that text to the other user's connected accounts if the
--    cubicle UUID was known. The publish-post / cron-publish-scheduled code in
--    this branch also filters accounts by draft.user_id; this closes it in the DB.
drop policy if exists "Users can insert own drafts" on public.drafts;
create policy "Users can insert own drafts" on public.drafts for insert
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.cubicles c where c.id = cubicle_id and c.user_id = (select auth.uid()))
  );
drop policy if exists "Users can update own drafts" on public.drafts;
create policy "Users can update own drafts" on public.drafts for update
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.cubicles c where c.id = cubicle_id and c.user_id = (select auth.uid()))
  );

-- 2) social_accounts: every write already goes through edge functions with the
--    service role (bluesky-connect, discord-connect, *-oauth-callback,
--    meta-pages, disconnect-account). The browser never writes this table, so
--    remove direct write access (prevents e.g. re-pointing an account's
--    cubicle_id from the browser).
revoke insert, update, delete on table public.social_accounts from anon, authenticated;
