# Lemon8 "assisted post" — plan (not built)

Lemon8 has no public posting API, so BrandParent can't post for you. Instead we
make posting by hand take under a minute, from the phone.

## Flow (per draft, per brand)
1. **Copy caption** — one button copies the draft text (plus hashtags, cut to
   Lemon8's caption limit) to the clipboard (`navigator.clipboard.writeText`),
   with a "Copied" toast. The brand name shows so you post on the right account.
2. **Download media** — saves the draft's images/video from post-media (signed
   URLs, original files, in order). On phones use the Web Share API
   (`navigator.share({ files })`) so photos land in the camera roll / share
   sheet; on desktop, plain downloads. Lemon8 wants portrait 3:4 photos; show a
   hint if an image isn't 3:4.
3. **Open Lemon8** — opens the app (`lemon8://` deep link on mobile, falling
   back to https://www.lemon8-app.com) in a new tab so BrandParent stays open.
4. **Mark done** — after posting, you tap "I posted it" (optionally paste the
   Lemon8 post link). That records the result like other platforms, so the
   calendar and post history show Lemon8 as published.

## Scheduling
Scheduled drafts with Lemon8 selected don't auto-post. At the scheduled time the
draft shows as "Ready to post on Lemon8" (and, later, a push/email reminder);
the other platforms still auto-publish as usual.

## Build notes (when we do it)
- Platform `lemon8` in the composer as a manual target; no tokens, nothing in
  social_accounts beyond an optional label (e.g. the @handle).
- publish-post / cron skip it with `{ ok: false, skipped: true, manual: true }`
  and store a `manual_pending` state per draft; "Mark done" writes
  `{ ok: true, post_url }` via a small owner-checked edge function.
- Style: purple/silver/gray, teal accents, big tap targets; copy says "brand".
