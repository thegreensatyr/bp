// Tumblr (OAuth2 + NPF) for BrandParent edge functions.
//
// - Connect: tumblr-oauth-callback exchanges the code, reads /v2/user/info and
//   stores access + refresh tokens plus the user's blogs (non-secret list in
//   social_accounts.account_meta). The primary blog is the default target;
//   tumblr-blogs lets the owner pick another one.
// - Post: POST /v2/blog/{blog-uuid}/posts with NPF content blocks. Text is split
//   into paragraph blocks; images go in by their signed post-media URL; a video
//   is uploaded as multipart (Tumblr only plays native video it has received
//   as bytes - a URL would become a link, not a video).
// - Tokens: access tokens live ~42 min, so they are refreshed with the stored
//   refresh token (rotates on every refresh) before posting and once more on 401.
import type { DraftMedia, MediaPlan, ResolvedMedia } from "./media.ts";

export const TUMBLR_API = "https://api.tumblr.com/v2";
export const TUMBLR_AUTHORIZE = "https://www.tumblr.com/oauth2/authorize";
export const TUMBLR_TOKEN = `${TUMBLR_API}/oauth2/token`;
export const TUMBLR_SCOPES = "basic write offline_access";
export const TUMBLR_REDIRECT_URI = "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/tumblr-oauth-callback";
export const TUMBLR_MAX_IMAGES = 30; // NPF allows up to 30 image blocks per post

export type TumblrBlog = { uuid: string; name: string; title: string; url: string; primary: boolean };
export type TumblrToken = { access_token: string; refresh_token?: string; expires_in?: number };

type PublishResult = { ok: boolean; post_id?: string | null; post_url?: string; note?: string };

/** Overridable for tests. */
export const tumblrDeps = {
  env: (k: string) => Deno.env.get(k),
};

function creds() {
  const id = tumblrDeps.env("TUMBLR_CLIENT_ID"), secret = tumblrDeps.env("TUMBLR_CLIENT_SECRET");
  if (!id || !secret) throw new Error("tumblr_not_configured: Tumblr isn't set up on the server yet (TUMBLR_CLIENT_ID / TUMBLR_CLIENT_SECRET missing).");
  return { id, secret };
}

/** Turns a Tumblr error body into one readable line. */
export function tumblrErrorText(data: any, status: number): string {
  const e = Array.isArray(data?.errors) ? data.errors[0] : null;
  const detail = e?.detail || e?.title || data?.meta?.msg || data?.error_description || data?.error || `HTTP ${status}`;
  const code = e?.code ? ` (code ${e.code})` : "";
  return `${String(detail).slice(0, 300)}${code}`;
}

// ---------------------------------------------------------------- OAuth

export function tumblrAuthorizeUrl(clientId: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, response_type: "code", scope: TUMBLR_SCOPES, state, redirect_uri: TUMBLR_REDIRECT_URI });
  return `${TUMBLR_AUTHORIZE}?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TumblrToken> {
  const { id, secret } = creds();
  const resp = await fetch(TUMBLR_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: id, client_secret: secret }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`tumblr_token_error: ${tumblrErrorText(data, resp.status)}`);
  return data as TumblrToken;
}

export function exchangeTumblrCode(code: string): Promise<TumblrToken> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: TUMBLR_REDIRECT_URI });
}

/** Reads the user's blogs; primary first. */
export async function fetchTumblrBlogs(accessToken: string): Promise<{ username: string; blogs: TumblrBlog[] }> {
  const resp = await fetch(`${TUMBLR_API}/user/info`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`tumblr_user_info_error: ${tumblrErrorText(data, resp.status)}`);
  const user = data?.response?.user || {};
  const blogs: TumblrBlog[] = (Array.isArray(user.blogs) ? user.blogs : [])
    .filter((b: any) => b && (b.uuid || b.name))
    .map((b: any) => ({ uuid: String(b.uuid || b.name), name: String(b.name || ""), title: String(b.title || b.name || ""), url: String(b.url || (b.name ? `https://${b.name}.tumblr.com/` : "")), primary: !!b.primary }));
  blogs.sort((a, b) => Number(b.primary) - Number(a.primary));
  return { username: String(user.name || ""), blogs };
}

export function tumblrAccountName(blog: TumblrBlog): string {
  return blog.title && blog.title !== blog.name ? `${blog.title} (${blog.name})` : blog.name;
}

export function tumblrExpiry(tok: TumblrToken): string | null {
  return tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null;
}

/** Returns a usable access token, refreshing (and persisting the rotated refresh token) when near expiry or when forced. */
export async function freshTumblrToken(svc: any, acct: any, force = false): Promise<string> {
  const exp = acct.token_expires_at ? Date.parse(acct.token_expires_at) : 0;
  if (!force && exp && exp - Date.now() > 5 * 60 * 1000) return acct.access_token;
  if (!acct.refresh_token) {
    if (!force && !exp) return acct.access_token;
    throw new Error("tumblr_reconnect_needed: the Tumblr login has expired — disconnect Tumblr and connect it again.");
  }
  let tok: TumblrToken;
  try { tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: acct.refresh_token }); }
  catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.startsWith("tumblr_not_configured")) throw e;
    throw new Error("tumblr_reconnect_needed: Tumblr wouldn't renew the login — disconnect Tumblr and connect it again. (" + msg.replace(/^tumblr_token_error: /, "").slice(0, 200) + ")");
  }
  const upd: Record<string, unknown> = { access_token: tok.access_token, token_expires_at: tumblrExpiry(tok) };
  if (tok.refresh_token) upd.refresh_token = tok.refresh_token;
  await svc.from("social_accounts").update(upd).eq("id", acct.id);
  Object.assign(acct, upd);
  return tok.access_token;
}

// ---------------------------------------------------------------- NPF

/** Plain text -> NPF text blocks (one per paragraph). */
export function textBlocks(content: string): Array<Record<string, unknown>> {
  return String(content || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((text) => ({ type: "text", text }));
}

function imageBlock(img: ResolvedMedia, url: string): Record<string, unknown> {
  const m: Record<string, unknown> = { url };
  if (img.mime) m.type = img.mime;
  if (img.width && img.height) { m.width = Math.round(img.width); m.height = Math.round(img.height); }
  const b: Record<string, unknown> = { type: "image", media: [m] };
  if (img.alt) b.alt_text = img.alt;
  return b;
}

/** Builds the NPF body (and multipart file parts, for a video). */
export async function buildTumblrPost(content: string, plan: MediaPlan, media: DraftMedia) {
  const blocks: Array<Record<string, unknown>> = [];
  const files: Array<{ id: string; name: string; bytes: Uint8Array; type: string }> = [];
  let note: string | undefined;
  if (plan.use === "images") {
    const imgs = plan.images.slice(0, TUMBLR_MAX_IMAGES);
    for (const img of imgs) blocks.push(imageBlock(img, await media.url(img)));
    if (plan.images.length > imgs.length) note = `Tumblr got the first ${TUMBLR_MAX_IMAGES} images only`;
  } else if (plan.use === "video") {
    const v = plan.video;
    if (v.source === "url") {
      // Legacy video_url: Tumblr can't play a remote MP4 natively, so link it.
      blocks.push({ type: "link", url: await media.url(v) });
    } else {
      let bytes: Uint8Array;
      try { bytes = await media.bytes(v); }
      catch (e) { throw new Error("tumblr_video_fetch_error: couldn't read the video (" + String((e as Error).message || e).slice(0, 200) + ")"); }
      const vm: Record<string, unknown> = { type: v.mime || "video/mp4", identifier: "video0" };
      if (v.width && v.height) { vm.width = Math.round(v.width); vm.height = Math.round(v.height); }
      blocks.push({ type: "video", media: vm });
      files.push({ id: "video0", name: (v.name || "video.mp4").replace(/[^A-Za-z0-9._-]+/g, "_"), bytes, type: v.mime || "video/mp4" });
    }
  }
  const content_blocks = [...blocks, ...textBlocks(content)];
  if (!content_blocks.length) throw new Error("tumblr_empty_post: this draft has no text or media to post.");
  return { body: { content: content_blocks, state: "published" }, files, note };
}

function postRequest(blog: string, token: string, body: unknown, files: Array<{ id: string; name: string; bytes: Uint8Array; type: string }>) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, accept: "application/json" };
  let payload: BodyInit;
  if (files.length) {
    const fd = new FormData();
    fd.append("json", new Blob([JSON.stringify(body)], { type: "application/json" }));
    for (const f of files) fd.append(f.id, new Blob([f.bytes as BlobPart], { type: f.type }), f.name);
    payload = fd;
  } else {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${TUMBLR_API}/blog/${encodeURIComponent(blog)}/posts`, { method: "POST", headers, body: payload });
}

function blogNameFor(acct: any): string {
  const blogs: TumblrBlog[] = acct.account_meta?.blogs || [];
  return blogs.find((b) => b.uuid === acct.external_account_id)?.name || "";
}

export async function publishToTumblr(svc: any, acct: any, content: string, plan: MediaPlan, media: DraftMedia): Promise<PublishResult> {
  const blog = acct.external_account_id;
  if (!blog) throw new Error("tumblr_no_blog: no Tumblr blog is selected for this brand — pick one under Accounts → Tumblr, or reconnect Tumblr.");
  const { body, files, note } = await buildTumblrPost(content, plan, media);
  let token = await freshTumblrToken(svc, acct);
  let resp = await postRequest(blog, token, body, files);
  if (resp.status === 401 && acct.refresh_token) {
    token = await freshTumblrToken(svc, acct, true);
    resp = await postRequest(blog, token, body, files);
  }
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const why = tumblrErrorText(data, resp.status);
    if (resp.status === 401) throw new Error(`tumblr_reconnect_needed: Tumblr rejected the login — disconnect Tumblr and connect it again. (${why})`);
    if (resp.status === 403) throw new Error(`tumblr_forbidden: Tumblr won't let this login post to that blog — check you're still a member of it, or pick another blog. (${why})`);
    if (resp.status === 429) throw new Error(`tumblr_rate_limited: Tumblr's daily posting limit was hit — try again later. (${why})`);
    if (resp.status === 413) throw new Error(`tumblr_media_too_large: Tumblr refused the file as too large. (${why})`);
    throw new Error(`tumblr_post_error: ${why}`);
  }
  const id = String(data?.response?.id ?? data?.response?.id_string ?? "") || null;
  const name = blogNameFor(acct);
  const out: PublishResult = { ok: true, post_id: id };
  if (id && name) out.post_url = `https://www.tumblr.com/${name}/${id}`;
  const notes = [note, plan.use === "video" && files.length ? "Tumblr is processing the video — it can take a few minutes to appear." : undefined].filter(Boolean);
  if (notes.length) out.note = notes.join(". ");
  return out;
}

// ---------------------------------------------------------------- connect (callback) logic

const SITE_APP_URL = "https://brandparent.app/app.html";

/** The whole OAuth callback, minus Deno.serve; returns the redirect target. */
export async function handleTumblrCallback(reqUrl: string, svc: any): Promise<string> {
  const url = new URL(reqUrl);
  const code = url.searchParams.get("code");
  const cubicleId = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const fail = (e: string) => `${SITE_APP_URL}?connect_error=${encodeURIComponent(e)}`;
  if (oauthError || !code || !cubicleId) return fail(oauthError === "access_denied" ? "tumblr: you cancelled the Tumblr login" : (oauthError || "missing_code"));
  try {
    const tok = await exchangeTumblrCode(code);
    const { username, blogs } = await fetchTumblrBlogs(tok.access_token);
    if (!blogs.length) return fail("tumblr_no_blogs: this Tumblr login has no blogs to post to.");
    const { data: cubicle } = await svc.from("cubicles").select("user_id").eq("id", cubicleId).single();
    if (!cubicle) return fail("cubicle_not_found");
    const chosen = blogs[0]; // primary first
    const { error } = await svc.from("social_accounts").upsert({
      user_id: cubicle.user_id,
      cubicle_id: cubicleId,
      platform: "tumblr",
      external_account_id: chosen.uuid,
      external_account_name: tumblrAccountName(chosen),
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || null,
      token_expires_at: tumblrExpiry(tok),
      account_meta: { username, blogs },
      connected_at: new Date().toISOString(),
    }, { onConflict: "cubicle_id,platform" });
    if (error) return fail("tumblr_save_error: " + String(error.message || error).slice(0, 200));
    if (blogs.length > 1) return `${SITE_APP_URL}?pick_tumblr=${encodeURIComponent(cubicleId)}`;
    return `${SITE_APP_URL}?connected=Tumblr`;
  } catch (e) {
    return fail(String((e as Error).message || e));
  }
}
