# BrandParent: build plan for the new platform integrations

_Read-only audit of `thegreensatyr/bp` @ `1523be9`, done 2026-10-05 (America/Phoenix)._

> **Update (branch `feat/discord-and-security`):** the deployed edge-function source and applied migrations are now committed under `supabase/`. The scheduler is the `cron-publish-scheduled` edge function, called every 5 minutes by pg_cron job `publish-scheduled-posts` (secret from Vault). Discord (webhook paste flow, §5.1 Option A) and the §1 security items 1–4 are implemented on that branch.

---

## 0. How the current integrations work (what's in the repo and what's deployed)

**Hosting.** Netlify serves the static site (`server: Netlify`). The live `app.html` is byte-for-byte the same as the repo copy. There are **no Netlify Functions**. `_redirects` has one rule, which proxies `/tt-media/*` to the Supabase Storage bucket `tiktok-media`. That gives TikTok's `PULL_FROM_URL` media a URL on `brandparent.app`, the domain TikTok verified.

**The backend source is not in the repo.** Every server-side step runs in Supabase Edge Functions on project `owxaolqikmgtlegtficq`, but none of that code is committed. I checked which functions are deployed with harmless `OPTIONS` requests (a real function answers 200/302, a missing one answers 404):

| Deployed (exists) | Purpose (inferred from callers) |
|---|---|
| `meta-oauth-callback` (302) | Exchanges the FB code for a token, then sends the user back to `app.html?pick_facebook=<cubicle>` |
| `meta-pages` (`list` / `select`) | Page picker. Pending pages wait in table `meta_pending_pages` |
| `tiktok-oauth-callback` (302) | TikTok code exchange |
| `tiktok-creator-info` | Fetches the creator info that TikTok's UX rules require before each post |
| `bluesky-connect` | Takes a handle and app password and verifies them (no OAuth) |
| `linkedin-oauth-callback` (302) | **Deployed, but unusable**: `LINKEDIN_CLIENT_ID` is `''` in the front end |
| `pinterest-oauth-callback` (302) | **Deployed, but unusable**: `PINTEREST_CLIENT_ID` is `''` |
| `publish-post` | Fan-out publisher. Takes `{draft_id}` and returns `{results:{<platform>:{ok,post_id,error,note}}}` |
| `disconnect-account` | Removes a `social_accounts` row |
| `create-checkout-session`, `stripe-webhook`, `voice-interview`, `optimize-caption`, `detect-site-theme`, `upload-cubicle-logo` | Billing, AI, and branding |

Not found (404): any `tumblr-*` or `discord-*` function, and every scheduler name I tried (`publish-scheduled`, `cron`, `process-scheduled`, …).

**OAuth pattern** (`app.html` ~L2233–2275):
1. A front-end `connectX()` builds the provider authorize URL. It uses a **public** client ID hard-coded in `app.html`, `redirect_uri = https://owxaolqikmgtlegtficq.supabase.co/functions/v1/<platform>-oauth-callback`, and `state = <cubicle id>`.
2. `<platform>-oauth-callback` exchanges the code using the **client secret, stored as an Edge Function secret** (the code comment confirms `TIKTOK_CLIENT_KEY` lives there). It writes a row to `social_accounts` and sends the user to `https://brandparent.app/app.html?connected=…`, `?connect_error=…` or `?pick_facebook=…`.
3. `init()` reads those query params and shows an alert or the picker.

**Token storage, table `public.social_accounts`.** Confirmed columns: `id, user_id, cubicle_id, platform, external_account_id, external_account_name, access_token, refresh_token, token_expires_at`. There is no metadata/settings column. RLS is on: an anonymous `select` returns `[]`.

**Posting path.**
- *Publish now:* insert into `drafts` (`status='draft'`), then `functions.invoke('publish-post',{draft_id})`, and the per-platform results are shown to the user.
- *Schedule:* insert into `drafts` with `status='scheduled'`, `scheduled_for`, `target_platforms`, and `platform_options` (TikTok privacy and other toggles). The UI promises an auto-publish "within 5 minutes", so a cron job must call the publisher. It is most likely `pg_cron` + `pg_net` hitting `publish-post`, but I **could not verify** it because it isn't an edge function I could find and it isn't in the repo.

**Status per platform:**
| Platform | Real? | Notes |
|---|---|---|
| Facebook Page | **Real, dev-mode only** | Graph v21, scopes `pages_show_list, pages_read_engagement, pages_manage_posts`. The UI itself says the Meta app is in Development Mode, so only accounts with a role on Meta app `1536478337966065` can connect. **Meta App Review is still needed** before anyone else can use it. |
| Instagram | **Real, dev-mode only** | `instagram_basic, instagram_content_publish`, through the Page linked to the IG account. Needs an image URL. Same App Review blocker. |
| TikTok | **Real** | Production client key, approved 2026-10-02 per the code comment. Scopes `user.info.basic, video.publish`. Full TikTok UX compliance UI. `help.html` is **out of date**: it still says posts stay private until review. |
| Bluesky | **Real** | No OAuth. App password goes to `bluesky-connect`. 300-char limit check in the UI. |
| LinkedIn | **Half-built** | Front-end flow plus deployed callback. Personal-profile scopes `openid profile w_member_social`. Missing: the dev app and client ID/secret. |
| Pinterest | **Half-built** | Front-end flow plus deployed callback. Scopes `boards:read, pins:write, user_accounts:read`. Posts to the *first board found*. Missing: the dev app and client ID/secret, plus Trial→Standard approval. |
| Discord, Tumblr, Lemon8 | **Nothing** | No code anywhere in the repo history and no deployed functions. |

I could not test any of this end to end without logging in. "Real" means a production key plus deployed functions, the UI's own status notes, and `help.html`.

---

## 1. Security findings (fix soon)

1. **Committed secrets: none found.** I ran gitleaks over all 32 commits and a manual regex pass. Its 5 hits are all **public-by-design identifiers**: the Supabase *publishable* key (`js/supabase-client.js`), TikTok *client keys* (`app.html`, `app_11.html`, `app.html.html`), the Meta *App ID*, and the Supabase project URL. No service-role key, `sb_secret_`, Stripe secret, webhook secret, Anthropic key, or OAuth client secret is in the repo or its history.
2. **Tokens reach the browser.** `renderConnections()` runs `sb.from('social_accounts').select('*')`, which returns `access_token` / `refresh_token` (and probably the Bluesky app password) to the client. RLS limits this to the owner, but any XSS would leak every connected account. Fix: `revoke select (access_token, refresh_token) on social_accounts from authenticated;` and select explicit columns in the front end (or read through a view or RPC).
3. **OAuth `state` is just the cubicle UUID.** It isn't signed and has no nonce or expiry. The callbacks can't see the user's JWT during the redirect, so they must trust `state`. Fix: before redirecting, have an edge function `oauth-start` mint an HMAC-signed state `{uid, cubicle_id, platform, nonce, exp}`. Each callback verifies the signature, checks expiry, checks that `cubicle.user_id === uid`, and consumes the nonce. PKCE is also an option for providers that support it.
4. **Stale app copies are live.** `app_7.html`, `app_8.html`, `app_9.html`, `app_10.html`, `app_11.html` and `app.html.html` all return 200 on brandparent.app. They carry old TikTok sandbox/old keys and older logic, which could confuse users and platform reviewers. Delete them, or move them out of the publish directory.
5. **Back end not under version control.** Run `supabase functions download <name>` for every function into `supabase/functions/` and commit (no secrets in the code; secrets stay in the dashboard). Also dump the schema (`supabase db dump --schema-only`) and the cron job definition. Every step below assumes this has been done, so new functions copy the real existing pattern.

---

## 2. Per-platform feasibility (researched Oct 2026)

| Platform | Post on user's behalf? | Auth | Scopes | Approval / review | Time | Key limits |
|---|---|---|---|---|---|---|
| **Discord** | Yes, posts into a channel the user picks in *their* server | **Option A:** user pastes a channel webhook URL (no dev app). **Option B:** OAuth2 `webhook.incoming` (Discord app; Discord creates the webhook and returns `webhook.id`/`token` in the token response) | `webhook.incoming` | None. Bot verification only applies to bots in 100+ servers, and no bot is needed | **Same day** | 2000-char content; images through embeds/attachments; about 5 req/2 s per webhook and 30 msg/min per channel. Per-message `username`/`avatar_url` override, so each cubicle can post as its brand name and logo. User needs *Manage Webhooks* permission. |
| **Tumblr** | Yes, to any blog the user owns | OAuth 2 auth-code (`/oauth2/authorize` → `/v2/oauth2/token`) | `basic write offline_access` | None. Register the app at tumblr.com/oauth/apps and set an OAuth2 redirect URL | **Same day** | Access token about 42 min (`expires_in` 2520), so refresh before every publish and store the rotated refresh token. 250 posts/day per user; 1,000 calls/hr and 5,000/day per app by default (raise by request). Post with NPF: `POST /v2/blog/{blog}/posts`. |
| **LinkedIn – personal profile** | Yes, as the member | OAuth 2 3-legged | `openid profile w_member_social` | Self-serve products "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" are granted instantly. Creating the app requires a LinkedIn **Page** to associate it with, verified by a Page admin | **Same day** | 60-day access token, **no refresh token** for non-partner apps, so the user must reconnect every 60 days (warn at day 50). Post through `POST /rest/posts` with a `LinkedIn-Version` header; images through `/rest/images?action=initializeUpload`. |
| **LinkedIn – Company Pages per brand** | Yes | Same OAuth, extra scopes | `w_organization_social r_organization_social` (+ `rw_organization_admin` to list pages) | **Community Management API**: registered legal entity only, verified business email (not Gmail), legal name and address, website, privacy policy, Page super-admin verification. Development tier first, then a Standard tier form plus screencast | **Weeks per tier** (LinkedIn publishes no SLA) | Must be a **separate new dev app** with no other products. This is the only way to give each cubicle its own Company Page. |
| **Pinterest** | Yes | OAuth 2 auth-code (`/oauth/` → `POST /v5/oauth/token` with Basic auth) | `boards:read boards:write pins:read pins:write user_accounts:read` | App request needs a verified **Pinterest Business account** and a public privacy policy, which gets **Trial**. Trial pins are sandbox-only and visible only to the creator (`api-sandbox.pinterest.com`). **Standard** needs an upgrade request plus a video of the full OAuth flow and creating a Pin | Trial: about 1–3 business days (stated). Standard: currently **2–4+ weeks** (community reports 17–26 days in Aug 2026, with no feedback) | Access token 30 d; refresh token 60 d, **rotated on every refresh**, so always save the new one. Trial: 1,000 req/day. Every Pin needs an image or video and a `board_id`. |
| **Lemon8** | **No** | n/a | n/a | No public developer or posting API exists (ByteDance has none for Lemon8). Third-party "Lemon8 APIs" are read-only scrapers and against the ToS | n/a | Only option: **assisted manual posting**. BrandParent prepares the caption and media, sends a reminder at the scheduled time, and the user taps "Copy caption + download image + open Lemon8". |

---

## 3. Recommended order (fastest wins first)

1. **Prerequisite (about 1 day): pull the edge function source into git, plus the security fixes from §1** (column revoke, signed state, delete stale pages). Everything else copies these patterns.
2. **Discord.** No approval at all. Option A (paste webhook) can ship in hours; Option B (OAuth) adds about half a day.
3. **Tumblr.** No approval; one OAuth function plus a publisher branch. One cubicle maps cleanly to one Tumblr blog.
4. **LinkedIn (personal).** Code already exists. The user just creates the app (instant) and pastes keys. Then start the Community Management application in parallel (weeks).
5. **Pinterest.** Code mostly exists. **Submit the app today** so the review clock starts. Build and test on Trial against the sandbox, record the video, apply for Standard, then wait 2–4+ weeks.
6. **Meta App Review** (not new, but it's what blocks FB/IG for real customers). Submit in parallel with 4 and 5.
7. **Lemon8 (assisted).** A small UI feature; do it whenever convenient.
8. **LinkedIn Company Pages.** Ships after Community Management approval.

---

## 4. Shared groundwork (do once, used by all new platforms)

**DB migration** (user reviews and runs it; I made no DB changes):
```sql
alter table social_accounts add column if not exists settings jsonb default '{}'::jsonb;  -- board_id, blog name, webhook channel, etc.
alter table drafts          add column if not exists publish_results jsonb;              -- per-platform outcome for scheduled posts
create table if not exists oauth_pending_choices (                                      -- generalises meta_pending_pages
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, cubicle_id uuid not null, platform text not null,
  access_token text, refresh_token text, token_expires_at timestamptz,
  choices jsonb not null, created_at timestamptz default now()
);
alter table oauth_pending_choices enable row level security;   -- service role only; no client policies
revoke select (access_token, refresh_token) on social_accounts from authenticated;
```

**New edge function `oauth-start`.** Input `{platform, cubicle_id}` with the user's JWT. Returns the full authorize URL with an HMAC-signed `state` (secret `OAUTH_STATE_SECRET`). The front-end `connectX()` functions call it instead of building URLs themselves, so client IDs also move into edge secrets.

**Shared helper `_shared/oauth.ts`:** `verifyState()`, `upsertSocialAccount()`, `redirectToApp({connected|connect_error|pick})`, `refreshIfExpiring(account)`.

**`publish-post` refactor.** Make it a dispatcher, `const PUBLISHERS = { facebook, instagram, tiktok, bluesky, linkedin, pinterest, tumblr, discord }`, with each publisher in `_shared/publishers/<platform>.ts` exporting `publish(account, draft) → {ok, post_id, url?, note?, error?}`. The scheduled-post cron must use the same dispatcher and write `drafts.publish_results`.

**Branded redirect URLs (optional but nicer for app reviewers).** Add these to `_redirects`:
```
/oauth/tumblr/callback     https://owxaolqikmgtlegtficq.supabase.co/functions/v1/tumblr-oauth-callback     200
/oauth/discord/callback    https://owxaolqikmgtlegtficq.supabase.co/functions/v1/discord-oauth-callback    200
/oauth/linkedin/callback   https://owxaolqikmgtlegtficq.supabase.co/functions/v1/linkedin-oauth-callback   200
/oauth/pinterest/callback  https://owxaolqikmgtlegtficq.supabase.co/functions/v1/pinterest-oauth-callback  200
```
The `redirect_uri` registered in the developer portal must match **exactly** the one sent in the authorize request *and* the token exchange. The existing LinkedIn and Pinterest callbacks almost certainly hard-code the `…supabase.co/functions/v1/…` URL in their token exchange, so register **that** URL for those two unless the callback code is changed too. For the new Tumblr and Discord functions you can pick `https://brandparent.app/oauth/<p>/callback`.

**Front end (`app.html`):**
- Add `discord`, `tumblr` and `lemon8` to `PLATFORM_LABEL`.
- Add a "Connect X" block for each in `#panel-connections`.
- Add per-platform char-limit warnings, the way `checkBlueskyLimit()` does it: Discord 2000, LinkedIn 3000, Pinterest description 500 / title 100, Tumblr none.
- Extend `optimize()` platform limits.
- Generalise `openFbPick()` into `openAccountPick(platform, cubicleId)` so the Pinterest board picker and Tumblr blog picker reuse it.
- Update `help.html`, `privacy.html` and `terms.html` platform lists. They must name every platform, and reviewers check this.

---

## 5. Per-platform build details

### 5.1 Discord (ship first)
**Code**
- *Option A (no dev app):* edge function `discord-connect` (modelled on `bluesky-connect`). Input `{cubicle_id, webhook_url}`. Validate it against `^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$`, then `GET` the webhook URL, which returns `name, channel_id, guild_id`. Upsert into `social_accounts` with `platform='discord'`, `external_account_id=webhook.id`, `access_token=webhook.token` (secret!), `external_account_name='#channel / server'`, `settings={channel_id,guild_id}`.
- *Option B (OAuth):* `discord-oauth-callback`. Exchange the code at `POST https://discord.com/api/oauth2/token` (form: `grant_type=authorization_code, code, redirect_uri, client_id, client_secret`) and store `webhook.id` and `webhook.token` from the response (the OAuth access token isn't needed). Authorize URL: `https://discord.com/oauth2/authorize?response_type=code&client_id=…&scope=webhook.incoming&redirect_uri=…&state=…`.
- `_shared/publishers/discord.ts`: `POST https://discord.com/api/webhooks/{id}/{token}?wait=true` with `{content (≤2000), username: cubicle.name, avatar_url: cubicle.logo_url, embeds: image_url ? [{image:{url:image_url}}] : [], allowed_mentions:{parse:[]}}`. `post_id` = returned message id. Handle 429 `retry_after`, and treat 404 as "webhook deleted, reconnect".
- `disconnect-account`: for Option B, also `DELETE` the webhook.
- Front end: `connectDiscord()` (Option A input field, or a redirect for Option B).

**User must do**
- Option A: nothing beyond pasting the webhook URL (Server Settings → Integrations → Webhooks → New → Copy URL).
- Option B: create an app at discord.com/developers/applications. Under OAuth2, add redirect `https://brandparent.app/oauth/discord/callback` (or the supabase URL). Copy the Client ID and Client Secret into Supabase secrets `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. Set the app icon, name, ToS URL and privacy URL.

### 5.2 Tumblr
**Code**
- `tumblr-oauth-callback`: verify state, then `POST https://api.tumblr.com/v2/oauth2/token` (`grant_type=authorization_code, code, client_id, client_secret, redirect_uri`) and `GET /v2/user/info` (bearer) to list the user's blogs. If there is 1 blog, upsert directly. If there are more, store them in `oauth_pending_choices` and redirect `?pick=tumblr&cubicle=…`.
- `tumblr-blogs` (`list` / `select`), modelled on `meta-pages`. On select, upsert `social_accounts` with `external_account_id=blog.uuid`, `external_account_name=blog.name`, `settings={blog_name}`, plus the tokens and expiry.
- `_shared/publishers/tumblr.ts`: `refreshIfExpiring()` (expiry about 42 min, so effectively always refresh, and persist the **new** refresh token). Then `POST https://api.tumblr.com/v2/blog/{blog_uuid}/posts` with NPF `{content:[{type:'text',text}, …(image? {type:'image',media:[{url:image_url}]}), …(video? {type:'video',url:video_url})], tags:[…]}`. If Tumblr rejects external image URLs, fall back to multipart upload with an `identifier`.
- Front end: `connectTumblr()` (through `oauth-start`), the picker, and a label.

**User must do**
- At https://www.tumblr.com/oauth/apps, register an app (name, website `https://brandparent.app`, default callback). Set **OAuth2 redirect URL** to `https://brandparent.app/oauth/tumblr/callback`; OAuth2 stays disabled until this is filled in.
- Paste the OAuth consumer key and secret into Supabase secrets `TUMBLR_CLIENT_ID` and `TUMBLR_CLIENT_SECRET`.
- Optional: request a rate-limit increase later.

### 5.3 LinkedIn (personal now, Company Pages later)
**Code (mostly exists)**
- Set `LINKEDIN_CLIENT_ID`, or better, move it into `oauth-start`.
- Check that the deployed `linkedin-oauth-callback`:
  - exchanges at `https://www.linkedin.com/oauth/v2/accessToken`;
  - calls `GET https://api.linkedin.com/v2/userinfo` for `sub` (gives `urn:li:person:{sub}`) and `name`;
  - stores `token_expires_at = now + expires_in` (about 60 d).
- Publisher: `POST https://api.linkedin.com/rest/posts`, headers `LinkedIn-Version: <YYYYMM, current>`, `X-Restli-Protocol-Version: 2.0.0`. Body: `{author:'urn:li:person:…', commentary, visibility:'PUBLIC', distribution:{feedDistribution:'MAIN_FEED'}, lifecycleState:'PUBLISHED'}`. For an image: `POST /rest/images?action=initializeUpload`, then PUT the bytes, then `content.media.id`.
- No refresh token, so add a "reconnect LinkedIn" banner when `token_expires_at < now()+10d`. The publisher returns a clear "reconnect" error after expiry.
- Later (Company Pages): add scopes `w_organization_social r_organization_social rw_organization_admin`. Add `linkedin-orgs` (`list` / `select`, through `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR`) and set `author='urn:li:organization:{id}'`. Store `settings={author_urn}` so each cubicle maps to one Page.

**User must do**
- Create a LinkedIn Company Page for BrandParent if there isn't one.
- At https://www.linkedin.com/developers/apps, Create app, associate it with that Page, and have the Page admin approve the verification link.
- Products tab: add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** (both instant).
- Auth tab: add the redirect URL `https://owxaolqikmgtlegtficq.supabase.co/functions/v1/linkedin-oauth-callback` (what the code sends today), and optionally the branded one.
- Paste the Client ID (front end, or `LINKEDIN_CLIENT_ID` secret) and the Client Secret into `LINKEDIN_CLIENT_SECRET`.
- For Company Pages: register a legal entity (LLC etc.) and get a business-domain email (e.g. `@brandparent.app`). Create a **second, new** dev app, request Community Management API Development tier, then Standard tier with a screencast. Allow several weeks.

### 5.4 Pinterest
**Code (mostly exists)**
- Set `PINTEREST_CLIENT_ID`.
- Expand scopes to `boards:read boards:write pins:read pins:write user_accounts:read`.
- Callback: exchange at `POST https://api.pinterest.com/v5/oauth/token` (Basic `client_id:secret`; `grant_type=authorization_code, code, redirect_uri`). Then `GET /v5/user_account` and `GET /v5/boards`. **Replace "first board" with a board picker**: store the boards in `oauth_pending_choices` and use `openAccountPick('pinterest')`; save `settings={board_id, board_name}`.
- Publisher: `POST /v5/pins` `{board_id, title (≤100), description (≤500), link (optional), alt_text, media_source:{source_type:'image_url', url:image_url}}`. Video pins use `source_type:'video_id'` after a media upload. Use `PINTEREST_API_BASE` env (`https://api-sandbox.pinterest.com` while on Trial, `https://api.pinterest.com` after Standard).
- Refresh: access token 30 d, refresh token 60 d **rotating**. Refresh when there's less than 7 d left, always save the new refresh token, and add a weekly cron refresh so idle accounts don't die.

**User must do**
- Convert or confirm a **Pinterest Business account** for BrandParent and claim/verify `brandparent.app` on Pinterest.
- At https://developers.pinterest.com/apps, Connect app. Give a detailed use case ("multi-brand scheduler; each brand pins to its own board") and the privacy policy URL `https://brandparent.app/privacy.html` (make sure it names Pinterest).
- Add redirect URI `https://owxaolqikmgtlegtficq.supabase.co/functions/v1/pinterest-oauth-callback`.
- Paste the App ID into `PINTEREST_CLIENT_ID` and the secret into `PINTEREST_CLIENT_SECRET`.
- After Trial is approved and the sandbox flow works, click **Upgrade**, upload a video (login → OAuth consent → pick board → publish Pin → Pin visible), and wait 2–4+ weeks.

### 5.5 Lemon8 (assisted / manual)
- No API exists. Don't use scrapers or unofficial automation; it breaks the ToS and risks account bans.
- Code:
  - Add a `lemon8` pseudo-platform (a `social_accounts` row with no token; just the handle in `external_account_name`).
  - `publish-post` skips it and returns `{ok:true, note:'manual'}`.
  - At the scheduled time the cron marks it `needs_manual` and sends an email or push notification.
  - In the app, a "Post to Lemon8" card has a Copy caption button (with hashtags), a Download image button, and an Open Lemon8 link (`https://www.lemon8-app.com/` / app store link). After posting, the user taps "Mark as posted".
- Bleed Check still runs on the caption.
- User must do: nothing (just enter their handle).

---

## 6. What Brit personally needs to do (checklist)
- [ ] Run `supabase functions download` for all functions plus a schema dump, and commit them (no secrets).
- [ ] Approve and run the §4 migration and the `revoke` on token columns.
- [ ] Delete `app_7.html` to `app_11.html` and `app.html.html` from the deployed site.
- [ ] **Discord:** nothing (Option A), or create a Discord app, add the redirect, paste `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.
- [ ] **Tumblr:** register an app, set the OAuth2 redirect URL, paste `TUMBLR_CLIENT_ID` / `TUMBLR_CLIENT_SECRET`.
- [ ] **LinkedIn:** create a Company Page, then a dev app with the two self-serve products and the redirect URL; paste the client ID and secret. Later: legal entity, business email, Community Management application.
- [ ] **Pinterest:** Business account, verify the domain, apply for the app today, set the redirect URL, paste the keys. Record the demo video, then apply for Standard.
- [ ] **Meta:** submit App Review for `pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish`, `instagram_basic` (+ Business Verification) so FB/IG work beyond your own accounts.
- [ ] Add a secret `OAUTH_STATE_SECRET` (random 32+ bytes) for signed state.
- [ ] Update `privacy.html`, `terms.html` and `help.html` to list every platform (reviewers check this). Fix the stale TikTok note in `help.html`.
