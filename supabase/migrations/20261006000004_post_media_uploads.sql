-- NOT YET APPLIED. Media uploads (PNG, JPEG, MP4) for the post composer.
-- Apply BEFORE deploying the publish-post / cron-publish-scheduled versions
-- that read drafts.media, and before merging the app.html that writes it.
-- Additive and safe to apply on its own: old code ignores the new column and bucket.
--
-- Privacy choice: the bucket is PRIVATE. Nothing is publicly readable.
--  * The browser uploads with the user's own JWT; RLS below confines each user
--    to {their user_id}/{a cubicle they own}/... and lets them read/delete only
--    their own files. No UPDATE policy, so files can't be overwritten in place.
--  * At publish time the edge functions (service role, bypasses RLS) download
--    the bytes for Bluesky / Discord / TikTok video / LinkedIn, and mint 24-hour
--    signed URLs for Facebook / Instagram / Pinterest, which must fetch a URL.
--    Scheduled posts get a fresh signed URL when the cron publishes them, so
--    links never expire while a post waits in the queue.
--  * TikTok photos are still re-staged into the existing public `tiktok-media`
--    bucket at publish time (TikTok only pulls from the verified brandparent.app domain).

-- 1) Bucket cap 50,000,000 bytes (50 MB), just under the project's global 50 MiB
--    Storage upload limit. Per-type limits (images 8 MB, video 50 MB / 90 s) are enforced in the
--    browser AND re-checked on the real bytes in the edge functions.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-media', 'post-media', false, 50000000, array['image/png','image/jpeg','video/mp4'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) Storage RLS. Path convention: {user_id}/{cubicle_id}/{random}.{png|jpg|jpeg|mp4}
--    Note: `objects.name` is table-qualified on purpose. Inside the EXISTS
--    subquery a bare `name` would resolve to cubicles.name (the brand name).
drop policy if exists "post-media owner insert" on storage.objects;
create policy "post-media owner insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'post-media'
  and (storage.foldername(objects.name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(objects.name), 1) = 2
  and lower(storage.extension(objects.name)) in ('png', 'jpg', 'jpeg', 'mp4')
  and exists (
    select 1 from public.cubicles c
    where c.id::text = (storage.foldername(objects.name))[2]
      and c.user_id = (select auth.uid())
  )
);

drop policy if exists "post-media owner select" on storage.objects;
create policy "post-media owner select"
on storage.objects for select
to authenticated
using (
  bucket_id = 'post-media'
  and (storage.foldername(objects.name))[1] = (select auth.uid())::text
);

drop policy if exists "post-media owner delete" on storage.objects;
create policy "post-media owner delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'post-media'
  and (storage.foldername(objects.name))[1] = (select auth.uid())::text
);

-- 3) drafts.media: list of uploaded files for the post (scheduled posts read it
--    at publish time). image_url / video_url stay as the paste-a-link fallback.
--    Element shape: {path, kind:'image'|'video', mime, size, width?, height?,
--    duration?, name?, alt?, jpeg_path?, jpeg_size?}
alter table public.drafts
  add column if not exists media jsonb not null default '[]'::jsonb;

comment on column public.drafts.media is
  'Uploaded post media in storage bucket post-media: [{path, kind, mime, size, width, height, duration, name, alt, jpeg_path, jpeg_size}]. Paths must be {user_id}/{cubicle_id}/<file>.';

-- Server-side guard: every path must sit in the draft owner's folder for the
-- draft's own cubicle, max 4 images OR 1 video, allowed types/sizes only.
-- This stops a crafted draft from pointing the (service-role) publisher at
-- somebody else's private file.
create or replace function public.post_media_is_valid(media jsonb, owner uuid, cubicle uuid)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  prefix text := '^' || owner::text || '/' || cubicle::text || '/[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.';
  el jsonb;
  p text;
  k text;
  n_img int := 0;
  n_vid int := 0;
begin
  if media is null then return true; end if;
  if jsonb_typeof(media) <> 'array' then return false; end if;
  if jsonb_array_length(media) > 4 then return false; end if;
  for el in select * from jsonb_array_elements(media) loop
    if jsonb_typeof(el) <> 'object' then return false; end if;
    p := el->>'path';
    k := el->>'kind';
    if p is null or k is null then return false; end if;
    if k = 'image' then
      if p !~ (prefix || '(png|jpg|jpeg)$') then return false; end if;
      if coalesce(el->>'mime', '') not in ('image/png', 'image/jpeg') then return false; end if;
      if jsonb_typeof(el->'size') is distinct from 'number' or (el->>'size')::numeric > 8000000 then return false; end if;
      n_img := n_img + 1;
    elsif k = 'video' then
      if p !~ (prefix || 'mp4$') then return false; end if;
      if coalesce(el->>'mime', '') <> 'video/mp4' then return false; end if;
      if jsonb_typeof(el->'size') is distinct from 'number' or (el->>'size')::numeric > 50000000 then return false; end if;
      if el ? 'jpeg_path' then return false; end if;
      n_vid := n_vid + 1;
    else
      return false;
    end if;
    if el ? 'jpeg_path' and jsonb_typeof(el->'jpeg_path') <> 'null'
       and (el->>'jpeg_path') !~ (prefix || '(jpg|jpeg)$') then
      return false;
    end if;
  end loop;
  if n_vid > 1 or (n_vid > 0 and n_img > 0) then return false; end if;
  return true;
end;
$$;

alter table public.drafts drop constraint if exists drafts_media_valid;
alter table public.drafts add constraint drafts_media_valid
  check (public.post_media_is_valid(media, user_id, cubicle_id));
