-- Server-side paywall (audit 2026-10-26, finding C2).
-- Only paid members (active or trialing) can create cubicles or drafts.
-- Restrictive policies are AND-ed with the existing "own rows" policies,
-- so nothing about ownership changes. Service-role code (webhooks, cron) is unaffected.

create or replace function public.is_paid_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and subscription_status in ('active', 'trialing')
  );
$$;

revoke execute on function public.is_paid_member() from public, anon;
grant execute on function public.is_paid_member() to authenticated;

drop policy if exists "Paid members only" on public.cubicles;
create policy "Paid members only" on public.cubicles
  as restrictive for insert to authenticated
  with check (public.is_paid_member());

drop policy if exists "Paid members only" on public.drafts;
create policy "Paid members only" on public.drafts
  as restrictive for insert to authenticated
  with check (public.is_paid_member());
