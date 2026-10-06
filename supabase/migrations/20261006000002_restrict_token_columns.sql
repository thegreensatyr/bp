-- NOT YET APPLIED. Deploy the updated app.html FIRST (it selects named columns
-- from social_accounts). The old app.html does select('*'), which fails with
-- "permission denied" once this runs.
--
-- Why table-level revoke + column-level grant: in Postgres a column-level
-- REVOKE has no effect while a table-level SELECT grant exists (Supabase grants
-- table-level SELECT to anon/authenticated by default), so we revoke the table
-- grant and re-grant only the non-secret columns.
--
-- Edge functions use the service role and are unaffected.

-- social_accounts: hide access_token / refresh_token (Bluesky app passwords and
-- Discord webhook URLs are also stored in access_token).
revoke select on table public.social_accounts from anon, authenticated;
grant select (id, user_id, cubicle_id, platform, external_account_id, external_account_name,
              token_expires_at, refresh_expires_at, connected_at)
  on table public.social_accounts to authenticated;
-- RLS ("Users can view own social accounts") still limits rows to the owner.

-- meta_pending_pages holds Facebook Page tokens; RLS has no policies (service
-- role only), so also drop the default table grants as defence in depth.
revoke all on table public.meta_pending_pages from anon, authenticated;
