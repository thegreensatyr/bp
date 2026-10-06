# Media uploads (PNG, JPEG, MP4)

The composer accepts real files: drag & drop, click, or tap-to-pick on phones.
Pasting an image or video URL still works under "Or paste a link…". If files are attached, they take precedence over the URL fields.

## What a post can carry

| Rule | Value | Why |
|---|---|---|
| File types | PNG, JPEG (.jpg/.jpeg), MP4 | Checked by extension, by magic bytes in the browser, by the bucket MIME allow-list, again on the server, and by a DB constraint |
| Images | up to **4**, **8 MB** each | Bluesky allows 4 per post at most. Instagram requires JPEG ≤ 8 MB. |
| Video | **1** MP4, **1–90 s**, **≤ 50 MB** | This is BrandParent's "short video". 50 MB stays under the project's 50 MiB Storage upload limit. |
| Mixing | images **or** a video, not both | Bluesky and Instagram (outside carousels) can't mix them |
| Oversized images | shrunk to JPEG (long edge ≤ 4096 px) in the browser before upload | Camera files are often bigger than 8 MB. Inputs over 40 MB are refused. |
| Bluesky/IG copy | a PNG, or any image over 1 MB, also gets a JPEG copy (`…-web.jpg`, ≤ 950 KB, ≤ 2000 px) | Bluesky's 1,000,000-byte blob limit, and Instagram is JPEG-only. If the copy is missing, the server re-encodes as a fallback. |

## Per-platform limits (checked Oct 2026) and what BrandParent does

| Platform | Platform's own limits | How BrandParent sends it | Skipped when |
|---|---|---|---|
| Bluesky | Images: 1,000,000 bytes each, max 4. Video: up to 10 min / 300 MB (verified email required, daily caps). | The server downloads the file and uploads it as a blob. Images go as `app.bsky.embed.images` (with aspect ratio). Video goes through `video.bsky.app` and is posted once processing finishes. | – (video fails with Bluesky's message if the email isn't verified) |
| Instagram | JPEG ≤ 8 MB, aspect 4:5–1.91:1. Reels: MP4 H.264/HEVC, 3 s–15 min, ≤ 300 MB, ≤ 1920 px wide, moov atom at the front. Carousel up to 10 items. Needs a public URL. | 24 h signed URL. One image → photo, 2–4 → carousel, video → Reel (status is polled). PNGs are sent as the JPEG copy. | No media; image outside 4:5–1.91:1; video under 3 s |
| Facebook Page | Photos < 10 MB. Video up to 2 GB / 40 min. | 24 h signed URL: `/{page}/photos`, multi-photo (unpublished photos + `attached_media`), or `/{page}/videos` with `file_url` | – |
| TikTok | Video: MP4/MOV/WebM, H.264, 23–60 fps, 360–4096 px, ≤ 4 GB, ≤ 10 min (creator max often 3 min). Photos: JPEG/WebP ≤ 20 MB, up to 35, pulled only from the verified domain. | Video: the server downloads it and uses FILE_UPLOAD (chunked). Photos are re-staged into the public `tiktok-media` bucket (verified domain) as PULL_FROM_URL. | No media |
| Discord | 10 MB per message on unboosted servers (L2: 50 MB, L3: 100 MB), 10 files per message | Multipart webhook attachments. Images are split across messages to keep each one ≤ 10 MB. | – (a 413 error says the file is too big for the server) |
| LinkedIn | – | First image only | Video |
| Pinterest | – | First image only, via 24 h signed URL | Video, or no media |

A skipped platform returns `{ ok:false, skipped:true, error }`. The composer shows it as "– X skipped: …" and the other platforms still post. If **every** target of a scheduled post is skipped, cron puts the post back to `draft` instead of marking it failed.

## Storage and privacy

* Bucket `post-media` is **private**. The limit is 50,000,000 bytes and the MIME allow-list is `image/png`, `image/jpeg`, `video/mp4`.
* Paths: `{user_id}/{cubicle_id}/{uuid}.{png|jpg|jpeg|mp4}` (plus `{uuid}-web.jpg` copies).
* RLS on `storage.objects` (authenticated only):
  * **insert** requires the first folder to equal `auth.uid()`, the second folder to be a cubicle the user owns, exactly two folders, and an allowed extension.
  * **select / delete** cover the user's own folder only.
  * There is **no update** policy, so files can't be overwritten or renamed. Anonymous users get nothing.
* Why private + signed URLs instead of a public bucket: drafts can sit for weeks before they're posted, and a public bucket would make every unposted draft image guessable and fetchable forever. Instagram, Facebook and Pinterest only need a URL for the few minutes it takes them to fetch the file. So `publish-post`/`cron-publish-scheduled` mint a **24-hour signed URL at publish time** (scheduled posts get a fresh one when cron fires). Bluesky, Discord, LinkedIn and TikTok video get the bytes directly from the server (service role), so no URL is exposed.
* Exception: TikTok photo posts must be pulled from the verified `brandparent.app` domain. Those images are copied into the existing public `tiktok-media` bucket at publish time (same as before).
* `drafts.media jsonb not null default '[]'` stores `[{path, kind, mime, size, width?, height?, duration?, jpeg_path?, name?}]`. The CHECK constraint `drafts_media_valid` (function `post_media_is_valid`) rejects:
  * paths outside `{user_id}/{cubicle_id}/`, path traversal, and wrong types/extensions
  * more than 4 images, more than 1 video, or images mixed with video
  * oversize files
* The server re-checks everything when the post publishes: it sniffs magic bytes and image dimensions, and reads the MP4 duration from `mvhd`. It never trusts the browser's numbers.
* Existing protections are unchanged: token columns stay hidden from `authenticated`, and drafts still require owning the cubicle.

## Deploy checklist (in order)

1. **Migration:** apply `supabase/migrations/20261006000004_post_media_uploads.sql`. It is additive and safe to re-run.
   Verify: the bucket `post-media` exists and is private, and `drafts.media` exists.
2. **Functions:** `supabase functions deploy publish-post cron-publish-scheduled --project-ref owxaolqikmgtlegtficq`.
   The `verify_jwt` values in `config.toml` are unchanged: publish-post true, cron false.
   `discord-connect` also imports `_shared/discord.ts`, but the changes are additive, so a redeploy is optional.
3. **Merge** the PR to `main`. Netlify then publishes `app.html`, `js/media-*.js` and `help.html`.
4. **Smoke test** on one brand:
   * one PNG to Bluesky + Discord
   * one JPEG to Instagram + Facebook
   * a 10 s MP4 to Bluesky/Facebook/TikTok
   * a scheduled post with an image (wait for cron)

The app must not ship before the migration. The browser only sends `media` when files are attached, so text-only and URL posts keep working in any order. Uploads, though, fail without the bucket.

## Rollback

* **UI:** revert the merge commit on `main` (Netlify republishes the old composer).
* **Functions:** redeploy `publish-post` and `cron-publish-scheduled` from the pre-merge `main` commit. Before this change those were publish-post v35 and cron v34. The old functions ignore `drafts.media`, so drafts that rely on uploads would post without media. Un-schedule those first, or leave the new functions in place.
* **Database** (only if really needed; it's additive):
  ```sql
  alter table public.drafts drop constraint if exists drafts_media_valid;
  drop function if exists public.post_media_is_valid(jsonb, uuid, uuid);
  alter table public.drafts drop column if exists media;
  drop policy if exists "post-media owner insert" on storage.objects;
  drop policy if exists "post-media owner select" on storage.objects;
  drop policy if exists "post-media owner delete" on storage.objects;
  -- empty the bucket (Dashboard or storage API), then:
  delete from storage.buckets where id = 'post-media';
  ```

## Tests

* `cd supabase/functions && deno check --node-modules-dir=auto publish-post/index.ts cron-publish-scheduled/index.ts _shared/*.ts`
* `deno test --allow-read --allow-env --allow-net=deno.land --node-modules-dir=auto _shared/`
  * Covers validation, MP4 parsing, per-platform publishers with mocked APIs, both handlers against a mocked Supabase, and Discord.
* `supabase/tests/local-pg/run.sh`
  * Runs every migration on a throwaway local Postgres, plus 29 RLS/constraint checks and an idempotency re-run.
* `NODE_PATH=…/node_modules supabase/tests/ui/run.sh`
  * Headless Chrome against `app.html` with all Supabase traffic mocked: pick, drag & drop, previews, progress, rejections, remove, and the publish/schedule payloads.

## Known gaps / follow-ups

* Uploads that are removed after a post is saved, or abandoned in a closed tab, stay in the bucket. A cleanup job should delete files not referenced by any draft after N days.
* Instagram Reels need the MP4 `moov` atom at the front. Most phone exports have this; the composer warns when it doesn't.
* Edge function budgets: a 50 MB video is held in memory while publishing. Instagram Reel status polling can take up to about 90 s. Cron processes drafts one at a time.
