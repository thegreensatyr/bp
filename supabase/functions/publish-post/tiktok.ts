// Shared TikTok Content Posting helpers (2026-09-23).
// Used by publish-post, cron-publish-scheduled and tiktok-creator-info.
//  - Refreshes the ~24h access token with the stored refresh token.
//  - Queries creator_info before every post (TikTok audit requirement).
//  - Photos: re-encoded to JPEG, copied into public bucket `tiktok-media`, and
//    served to TikTok from the verified domain https://brandparent.app/tt-media/...
//    (Netlify _redirects proxies that path to Supabase Storage).
//  - Videos: pushed straight to TikTok with FILE_UPLOAD (no domain needed).
//  - Uses the creator's choices saved on the draft (platform_options.tiktok).
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const API = "https://open.tiktokapis.com/v2";
export const TT_MEDIA_BASE = "https://brandparent.app/tt-media/";

export type TikTokOptions = {
  privacy_level?: string;
  disable_comment?: boolean;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  brand_content_toggle?: boolean; // "Branded content" (paid partnership)
  brand_organic_toggle?: boolean; // "Your brand"
};

const FRIENDLY: Record<string, string> = {
  access_token_invalid: "TikTok connection expired — disconnect and reconnect TikTok for this brand.",
  scope_not_authorized: "TikTok didn't grant posting permission — reconnect TikTok and allow all permissions.",
  spam_risk_too_many_posts: "TikTok's daily post limit for this account was reached. Try again tomorrow.",
  spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting right now.",
  reached_active_user_cap: "TikTok's daily limit for this app was reached. Try again tomorrow.",
  unaudited_client_can_only_post_to_private_accounts:
    "Until TikTok approves BrandParent, posts must be set to \"Only me\".",
  url_ownership_unverified: "TikTok couldn't verify the image link domain (brandparent.app).",
  privacy_level_option_mismatch: "That privacy option isn't available for this TikTok account — pick another.",
  file_format_check_failed: "TikTok didn't accept this file format.",
  duration_check_failed: "This video is longer than this TikTok account allows.",
  frame_rate_check_failed: "TikTok didn't accept this video's frame rate.",
  picture_size_check_failed: "TikTok didn't accept this image size.",
  rate_limit_exceeded: "TikTok is rate-limiting requests. Wait a minute and try again.",
};

export function tiktokErr(code: string, raw: unknown): Error {
  const friendly = FRIENDLY[code];
  return new Error(`tiktok_${code || "error"}: ${friendly || "TikTok rejected the post."} ${friendly ? "" : JSON.stringify(raw).slice(0, 300)}`.trim());
}

// ---------- token ----------
export async function freshTikTokToken(svc: any, acct: any): Promise<string> {
  const exp = acct.token_expires_at ? Date.parse(acct.token_expires_at) : 0;
  if (exp && exp - Date.now() > 5 * 60 * 1000) return acct.access_token;
  if (!acct.refresh_token) {
    if (!exp) return acct.access_token; // unknown expiry, try it
    throw new Error("tiktok_access_token_invalid: " + FRIENDLY.access_token_invalid);
  }
  const body = new URLSearchParams({
    client_key: Deno.env.get("TIKTOK_CLIENT_KEY") || "",
    client_secret: Deno.env.get("TIKTOK_CLIENT_SECRET") || "",
    grant_type: "refresh_token",
    refresh_token: acct.refresh_token,
  });
  const resp = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error("tiktok_access_token_invalid: " + FRIENDLY.access_token_invalid + " (refresh failed: " + JSON.stringify(data).slice(0, 200) + ")");
  }
  const now = Date.now();
  const upd: Record<string, unknown> = {
    access_token: data.access_token,
    token_expires_at: new Date(now + (Number(data.expires_in) || 86400) * 1000).toISOString(),
  };
  if (data.refresh_token) upd.refresh_token = data.refresh_token;
  if (data.refresh_expires_in) upd.refresh_expires_at = new Date(now + Number(data.refresh_expires_in) * 1000).toISOString();
  await svc.from("social_accounts").update(upd).eq("id", acct.id);
  acct.access_token = data.access_token;
  acct.token_expires_at = upd.token_expires_at;
  if (data.refresh_token) acct.refresh_token = data.refresh_token;
  return data.access_token;
}

// ---------- creator info ----------
export type CreatorInfo = {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
};

export async function tiktokCreatorInfo(token: string): Promise<CreatorInfo> {
  const resp = await fetch(`${API}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: "{}",
  });
  const data = await resp.json().catch(() => ({}));
  const code = data?.error?.code;
  if (!resp.ok || (code && code !== "ok")) throw tiktokErr(code || "creator_info_failed", data);
  const d = data.data || {};
  return {
    creator_avatar_url: d.creator_avatar_url,
    creator_username: d.creator_username,
    creator_nickname: d.creator_nickname,
    privacy_level_options: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [],
    comment_disabled: !!d.comment_disabled,
    duet_disabled: !!d.duet_disabled,
    stitch_disabled: !!d.stitch_disabled,
    max_video_post_duration_sec: d.max_video_post_duration_sec,
  };
}

// ---------- media ----------
async function stagePhoto(svc: any, imageUrl: string, key: string): Promise<string> {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error("tiktok_image_fetch_error: couldn't download this draft's image (" + r.status + ").");
  const bytes = new Uint8Array(await r.arrayBuffer());
  let out: Uint8Array;
  try {
    const img: any = await Image.decode(bytes);
    if (img.width > 1080) img.resize(1080, Image.RESIZE_AUTO);
    if (img.height > 1920) img.resize(Image.RESIZE_AUTO, 1920);
    out = await img.encodeJPEG(90);
  } catch (e) {
    const ct = r.headers.get("content-type") || "";
    if (!/jpe?g|webp/i.test(ct)) {
      throw new Error("tiktok_image_format: TikTok needs a JPG or WEBP image and this one couldn't be converted (" + String(e).slice(0, 120) + ").");
    }
    out = bytes;
  }
  const path = `${key}/${Date.now()}.jpg`;
  const { error } = await svc.storage.from("tiktok-media").upload(path, out, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error("tiktok_media_stage_error: " + String(error.message || error));
  return TT_MEDIA_BASE + path;
}

async function pollStatus(token: string, publishId: string, maxMs = 25000): Promise<{ status: string; fail_reason?: string; post_ids?: unknown[] }> {
  const start = Date.now();
  let last: any = { status: "PROCESSING" };
  while (Date.now() - start < maxMs) {
    await new Promise((res) => setTimeout(res, 2500));
    const resp = await fetch(`${API}/post/publish/status/fetch/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = await resp.json().catch(() => ({}));
    last = data?.data || last;
    const s = last?.status;
    if (s === "PUBLISH_COMPLETE" || s === "FAILED" || s === "SEND_TO_USER_INBOX") break;
  }
  return { status: last?.status || "PROCESSING", fail_reason: last?.fail_reason, post_ids: last?.publicaly_available_post_id };
}

// ---------- publish ----------
export async function publishToTikTokFull(
  svc: any,
  acct: any,
  draft: any,
): Promise<{ publish_id: string; status: string; note?: string }> {
  const opts: TikTokOptions = (draft.platform_options && draft.platform_options.tiktok) || {};
  const caption = String(draft.content || "").trim();
  if (!draft.image_url && !draft.video_url) {
    throw new Error("tiktok_needs_media: TikTok posts need a photo or video — add one to this draft first.");
  }
  if (!opts.privacy_level) {
    throw new Error("tiktok_needs_privacy: Choose who can see this TikTok (the TikTok settings panel) before posting.");
  }
  if (opts.brand_content_toggle && opts.privacy_level === "SELF_ONLY") {
    throw new Error("tiktok_branded_private: Branded content can't be posted as \"Only me\" — pick another visibility.");
  }

  const token = await freshTikTokToken(svc, acct);
  const info = await tiktokCreatorInfo(token);
  if (info.privacy_level_options.length && !info.privacy_level_options.includes(opts.privacy_level)) {
    throw tiktokErr("privacy_level_option_mismatch", { chosen: opts.privacy_level, allowed: info.privacy_level_options });
  }
  const disableComment = info.comment_disabled ? true : !!opts.disable_comment;
  const brand = { brand_content_toggle: !!opts.brand_content_toggle, brand_organic_toggle: !!opts.brand_organic_toggle };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" };

  let publishId = "";

  if (draft.video_url) {
    const vr = await fetch(draft.video_url);
    if (!vr.ok) throw new Error("tiktok_video_fetch_error: couldn't download this draft's video (" + vr.status + ").");
    const bytes = new Uint8Array(await vr.arrayBuffer());
    const size = bytes.byteLength;
    if (size > 250 * 1024 * 1024) throw new Error("tiktok_video_too_large: keep TikTok videos under 250MB.");
    const MIN = 5 * 1024 * 1024, MAXC = 64 * 1024 * 1024;
    let chunkSize = size, total = 1;
    if (size > MAXC) {
      chunkSize = 32 * 1024 * 1024;
      total = Math.floor(size / chunkSize); // last chunk absorbs remainder (allowed up to 128MB)
    }
    if (size < MIN) { chunkSize = size; total = 1; }
    const initResp = await fetch(`${API}/post/publish/video/init/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: opts.privacy_level,
          disable_comment: disableComment,
          disable_duet: info.duet_disabled ? true : !!opts.disable_duet,
          disable_stitch: info.stitch_disabled ? true : !!opts.disable_stitch,
          ...brand,
        },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: total },
      }),
    });
    const init = await initResp.json().catch(() => ({}));
    if (!initResp.ok || init?.error?.code !== "ok") throw tiktokErr(init?.error?.code, init);
    publishId = init.data.publish_id;
    const uploadUrl = init.data.upload_url;
    const ct = vr.headers.get("content-type") || "video/mp4";
    for (let i = 0; i < total; i++) {
      const startB = i * chunkSize;
      const endB = i === total - 1 ? size : startB + chunkSize; // exclusive
      const part = bytes.subarray(startB, endB);
      const up = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": /mp4|quicktime|webm/i.test(ct) ? ct : "video/mp4",
          "Content-Length": String(part.byteLength),
          "Content-Range": `bytes ${startB}-${endB - 1}/${size}`,
        },
        body: part,
      });
      if (!up.ok && up.status !== 206 && up.status !== 201) {
        throw new Error("tiktok_video_upload_error: chunk " + (i + 1) + "/" + total + " failed (" + up.status + ") " + (await up.text()).slice(0, 200));
      }
    }
  } else {
    const photoUrl = await stagePhoto(svc, draft.image_url, String(draft.id || "draft"));
    const initResp = await fetch(`${API}/post/publish/content/init/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        post_info: {
          title: caption.split("\n")[0].slice(0, 90),
          description: caption.slice(0, 4000),
          privacy_level: opts.privacy_level,
          disable_comment: disableComment,
          auto_add_music: true,
          ...brand,
        },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [photoUrl] },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
      }),
    });
    const init = await initResp.json().catch(() => ({}));
    if (!initResp.ok || init?.error?.code !== "ok") throw tiktokErr(init?.error?.code, init);
    publishId = init.data.publish_id;
  }

  const st = await pollStatus(token, publishId);
  if (st.status === "FAILED") throw tiktokErr(st.fail_reason || "publish_failed", st);
  return {
    publish_id: publishId,
    status: st.status,
    note: st.status === "PUBLISH_COMPLETE" ? undefined : "TikTok is still processing it — it can take a few minutes to appear on your profile.",
  };
}
