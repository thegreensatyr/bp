-- NOT YET APPLIED. Required before discord-connect can save a connection
-- (until then it returns 503 "discord_not_enabled" and saves nothing).
-- Safe/additive: only widens the allowed platform list.
alter table public.social_accounts drop constraint if exists social_accounts_platform_check;
alter table public.social_accounts add constraint social_accounts_platform_check
  check (platform = any (array['facebook','instagram','bluesky','linkedin','tiktok','pinterest','discord']::text[]));
