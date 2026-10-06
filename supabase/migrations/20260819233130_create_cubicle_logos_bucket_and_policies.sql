-- Exported read-only from supabase_migrations.schema_migrations (20260819233130) on 2026-10-05

-- Public bucket for per-cubicle logo uploads. Public so badges/sidebar can
-- render logos via a plain <img src> without needing signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cubicle-logos', 'cubicle-logos', true, 5242880, array['image/png','image/jpeg','image/webp','image/svg+xml'])
on conflict (id) do nothing;

-- Anyone can read (bucket is public, and app badges need to load images
-- without auth), but only the owning user can write/replace/delete their
-- own files. Path convention enforced by the app: {user_id}/{cubicle_id}-*.ext
create policy "cubicle-logos public read"
on storage.objects for select
using (bucket_id = 'cubicle-logos');

create policy "cubicle-logos owner insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'cubicle-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "cubicle-logos owner update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'cubicle-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "cubicle-logos owner delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'cubicle-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);
