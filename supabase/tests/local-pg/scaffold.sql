-- Minimal stand-in for the Supabase platform pieces the migrations touch.
do $$ begin if not exists (select 1 from pg_roles where rolname=$q$anon$q$) then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname=$q$authenticated$q$) then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname=$q$service_role$q$) then create role service_role nologin bypassrls; end if; end $$;
create schema auth; create schema storage; create schema extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role', true) $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema auth, storage, public, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.objects, storage.buckets to authenticated, service_role;
grant select on storage.objects, storage.buckets to anon;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts,1)-1]; end $$;
create function storage.filename(name text) returns text language plpgsql as $$
declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[array_length(_parts,1)]; end $$;
create function storage.extension(name text) returns text language plpgsql as $$
declare _parts text[]; _filename text; begin select string_to_array(name, '/') into _parts;
select _parts[array_length(_parts,1)] into _filename; return reverse(split_part(reverse(_filename), '.', 1)); end $$;
grant execute on all functions in schema storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
