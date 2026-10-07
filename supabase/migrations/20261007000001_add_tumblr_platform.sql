-- NOT YET APPLIED. Required before tumblr-oauth-callback can save a connection.
-- Safe/additive: widens the platform list and adds one non-secret jsonb column.
--
-- account_meta holds non-secret per-account details. For Tumblr:
--   { "blogs": [{ "uuid", "name", "title", "url", "primary" }] }
-- so the browser can show a blog picker. Tokens stay in access_token /
-- refresh_token, which the browser still cannot read.
alter table public.social_accounts drop constraint if exists social_accounts_platform_check;
alter table public.social_accounts add constraint social_accounts_platform_check
  check (platform = any (array['facebook','instagram','bluesky','linkedin','tiktok','pinterest','discord','tumblr']::text[]));

alter table public.social_accounts add column if not exists account_meta jsonb;
grant select (account_meta) on table public.social_accounts to authenticated;
