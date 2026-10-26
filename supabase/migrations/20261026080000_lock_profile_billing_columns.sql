-- Lock billing columns on profiles (audit 2026-10-26, finding C1).
-- Before: any logged-in user could UPDATE/INSERT every profiles column, including
-- subscription_status, so one browser-console call could mark an account paid.
-- After: browsers may only change parent_name and tutorials_enabled on their own row.
-- Billing columns are written only by stripe-webhook (service role) and the
-- handle_new_user signup trigger (security definer) — neither is affected.

revoke insert, update, delete, truncate on table public.profiles from anon, authenticated;
grant update (parent_name, tutorials_enabled) on table public.profiles to authenticated;

-- Rows are created only by the signup trigger, so the browser insert rule is unused.
drop policy if exists "Users can insert own profile" on public.profiles;

-- Performance advisor: two foreign keys without an index (finding L3).
create index if not exists drafts_social_account_id_idx on public.drafts (social_account_id);
create index if not exists meta_pending_pages_user_id_idx on public.meta_pending_pages (user_id);
