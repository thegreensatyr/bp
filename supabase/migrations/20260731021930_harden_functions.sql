-- Exported read-only from supabase_migrations.schema_migrations (20260731021930) on 2026-10-05

alter function public.set_updated_at() set search_path = public;
alter function public.handle_new_user() set search_path = public;

revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.set_updated_at() from anon, authenticated, public;
