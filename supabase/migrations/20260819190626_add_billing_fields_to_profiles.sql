-- Exported read-only from supabase_migrations.schema_migrations (20260819190626) on 2026-10-05
alter table public.profiles
  add column if not exists subscription_tier text not null default 'none' check (subscription_tier in ('none', 'founding_member', 'studio')),
  add column if not exists subscription_status text not null default 'inactive' check (subscription_status in ('inactive', 'trialing', 'active', 'past_due', 'canceled')),
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists paid_at timestamptz;

comment on column public.profiles.subscription_tier is 'none = never paid, founding_member = $97 lifetime one-time, studio = $27/mo recurring';
comment on column public.profiles.subscription_status is 'mirrors Stripe subscription/payment status; inactive means no access to paid cubicle features';
