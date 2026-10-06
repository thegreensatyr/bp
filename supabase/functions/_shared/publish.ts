// One implementation of "post this draft to these accounts", shared by
// publish-post (Publish now) and cron-publish-scheduled (scheduled posts), so
// media handling can't drift between the two. Ported from the per-function
// copies; behaviour for drafts that only use the legacy image_url / video_url
// fields is unchanged except where noted in the PR.
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { publishToTikTokFull, type TikTokMediaInput } from "./tiktok.ts";
import { collectDiscordImages, type DiscordFile, publishToDiscord } from "./discord.ts";
import { DraftMedia, fmtBytes, LIMITS, MediaError, type MediaPlan, planMedia, type ResolvedMedia } from "./media.ts";

export type PublishResult = {
  ok: boolean;
  skipped?: boolean;
  post_id?: string | null;
  post_url?: string;
  status?: string;
  note?: string;
  error?: string;
  message_ids?: string[];
};

/** Overridable for tests (no real waiting). */
export const deps = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const GRAPH = "https://graph.facebook.com/v21.0";
const BLUESKY_VIDEO_MAX_BYTES = 300_000_000; // Bluesky's current per-video cap (Aug 2026)

// ------------------------------------------------------------------ image transcoding (server fallback)

/** Re-encodes to JPEG, shrinking until it fits `maxBytes`. Used only when the browser didn't supply a JPEG copy. */
export async function toJpegUnder(bytes: Uint8Array, maxBytes: number, maxEdge = 2000): Promise<Uint8Array> {
  const img: any = await Image.decode(bytes);
  let edge = Math.min(maxEdge, Math.max(img.width, img.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const scaled: any = img.clone();
    if (Math.max(scaled.width, scaled.height) > edge) {
      if (scaled.width >= scaled.height) scaled.resize(edge, Image.RESIZE_AUTO);
      else scaled.resize(Image.RESIZE_AUTO, edge);
    }
    for (const q of [85, 72, 60]) {
      const out: Uint8Array = await scaled.encodeJPEG(q);
      if (out.byteLength <= maxBytes) return out;
    }
    edge = Math.round(edge * 0.75);
  }
  throw new Error("could not compress under limit");
}

// ------------------------------------------------------------------ Facebook

async function fbJson(resp: Response) {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data as any).error) throw new Error("facebook_error: " + JSON.stringify(data).slice(0, 500));
  return data as any;
}

export async function publishToFacebook(pageId: string, pageToken: string, content: string, plan: MediaPlan, media: DraftMedia): Promise<PublishResult> {
  if (plan.use === "images" && plan.images.length === 1) {
    const params = new URLSearchParams({ access_token: pageToken, url: await media.url(plan.images[0]), caption: content });
    const data = await fbJson(await fetch(`${GRAPH}/${pageId}/photos?${params}`, { method: "POST" }));
    return { ok: true, post_id: data.post_id || data.id };
  }
  if (plan.use === "images") {
    // Multi-photo post: upload each photo unpublished, then one feed post that attaches them.
    const ids: string[] = [];
    for (const img of plan.images) {
      const params = new URLSearchParams({ access_token: pageToken, url: await media.url(img), published: "false" });
      const data = await fbJson(await fetch(`${GRAPH}/${pageId}/photos?${params}`, { method: "POST" }));
      ids.push(String(data.id));
    }
    const data = await fbJson(await fetch(`${GRAPH}/${pageId}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: content, attached_media: ids.map((id) => ({ media_fbid: id })), access_token: pageToken }),
    }));
    return { ok: true, post_id: data.id };
  }
  if (plan.use === "video") {
    const data = await fbJson(await fetch(`${GRAPH}/${pageId}/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_url: await media.url(plan.video), description: content, access_token: pageToken }),
    }));
    return { ok: true, post_id: data.id, note: "Facebook is processing the video — it can take a few minutes to appear on the Page." };
  }
  const params = new URLSearchParams({ access_token: pageToken, message: content });
  const data = await fbJson(await fetch(`${GRAPH}/${pageId}/feed?${params}`, { method: "POST" }));
  return { ok: true, post_id: data.post_id || data.id };
}

// ------------------------------------------------------------------ Instagram

async function igPost(path: string, body: Record<string, unknown>, step: string) {
  const resp = await fetch(`${GRAPH}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !(data as any).id) throw new Error(`instagram_${step}_error: ` + JSON.stringify(data).slice(0, 500));
  return data as any;
}

/** Instagram only takes JPEG: use the original if it's a JPEG, else the browser's JPEG copy, else convert here. */
async function igImageUrl(img: ResolvedMedia, media: DraftMedia): Promise<string> {
  if (img.source === "url" || img.mime === "image/jpeg") return await media.url(img);
  if (img.jpegPath) return await media.url(img, "jpeg");
  let jpeg: Uint8Array;
  try { jpeg = await toJpegUnder(await media.bytes(img), LIMITS.imageMaxBytes, 1440); }
  catch (e) { throw new Error(`instagram_image_convert_error: Instagram needs JPEG images and "${img.name}" couldn't be converted (${String(e).slice(0, 100)}).`); }
  return await media.storeDerived(img, "ig.jpg", jpeg, "image/jpeg");
}

async function igWaitReady(containerId: string, token: string, hint = "", maxMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await deps.sleep(3000);
    const r = await fetch(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    const d: any = await r.json().catch(() => ({}));
    if (d.status_code === "FINISHED") return;
    if (d.status_code === "ERROR" || d.status_code === "EXPIRED") {
      throw new Error("instagram_video_processing_failed: Instagram couldn't process this video (" + String(d.status || d.status_code).slice(0, 200) + "). Reels need H.264/HEVC MP4, 23–60 fps, at most 1920 px wide." + hint);
    }
  }
  throw new Error("instagram_video_timeout: Instagram was still processing the video after 90 seconds, so it wasn't published. Try Publish again in a minute.");
}

export async function publishToInstagram(igUserId: string, token: string, content: string, plan: MediaPlan, media: DraftMedia): Promise<PublishResult> {
  if (plan.use === "images" && plan.images.length === 1) {
    const c = await igPost(`${igUserId}/media`, { image_url: await igImageUrl(plan.images[0], media), caption: content, access_token: token }, "container");
    const p = await igPost(`${igUserId}/media_publish`, { creation_id: c.id, access_token: token }, "publish");
    return { ok: true, post_id: p.id };
  }
  if (plan.use === "images") {
    const children: string[] = [];
    for (const img of plan.images) {
      const c = await igPost(`${igUserId}/media`, { image_url: await igImageUrl(img, media), is_carousel_item: true, access_token: token }, "container");
      children.push(String(c.id));
    }
    const car = await igPost(`${igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: content, access_token: token }, "carousel");
    const p = await igPost(`${igUserId}/media_publish`, { creation_id: car.id, access_token: token }, "publish");
    return { ok: true, post_id: p.id };
  }
  if (plan.use === "video") {
    const c = await igPost(`${igUserId}/media`, { media_type: "REELS", video_url: await media.url(plan.video), caption: content, share_to_feed: true, access_token: token }, "container");
    await igWaitReady(c.id, token, plan.video.moovFirst === false
      ? " This file has its index (moov atom) at the end; re-export it with \"fast start\" / \"optimize for web\" turned on."
      : "");
    const p = await igPost(`${igUserId}/media_publish`, { creation_id: c.id, access_token: token }, "publish");
    return { ok: true, post_id: p.id };
  }
  throw new Error("instagram_needs_image: Instagram requires an image or video with every post — add one to this draft first.");
}

// ------------------------------------------------------------------ Bluesky

function blueskyPostUrl(handle: string, uri: string): string {
  return `https://bsky.app/profile/${handle}/post/${uri.split("/").pop()}`;
}

async function blueskyCreateSession(handle: string, appPassword: string) {
  const resp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  const session = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("bluesky_auth_error: " + JSON.stringify(session).slice(0, 300));
  return session as { accessJwt: string; did: string; handle: string; didDoc?: { service?: Array<{ id: string; serviceEndpoint: string }> } };
}

/** Picks bytes that fit Bluesky's 1,000,000-byte image blob limit. */
export async function blueskyImageBytes(img: ResolvedMedia, media: DraftMedia): Promise<{ bytes: Uint8Array; contentType: string }> {
  const max = LIMITS.blueskyImageMaxBytes;
  if (img.source === "upload" && (img.size ?? Infinity) > max && img.jpegPath) {
    const j = await media.bytes(img, "jpeg");
    if (j.byteLength <= max) return { bytes: j, contentType: "image/jpeg" };
  }
  const orig = await media.bytes(img);
  if (orig.byteLength <= max) return { bytes: orig, contentType: img.mime || "image/jpeg" };
  try {
    return { bytes: await toJpegUnder(orig, max), contentType: "image/jpeg" };
  } catch {
    throw new Error(`bluesky_image_too_large: "${img.name}" is ${fmtBytes(orig.byteLength)} and couldn't be shrunk under Bluesky's 1 MB image limit.`);
  }
}

async function blueskyCreatePost(handle: string, accessJwt: string, did: string, content: string, embed?: Record<string, unknown>) {
  let text = content;
  if (text.length > 300) text = text.slice(0, 297) + "...";
  const record: Record<string, unknown> = { "$type": "app.bsky.feed.post", text, createdAt: new Date().toISOString() };
  if (embed) record.embed = embed;
  const resp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": `Bearer ${accessJwt}` },
    body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("bluesky_post_error: " + JSON.stringify(data).slice(0, 300));
  return { uri: (data as any).uri as string, url: blueskyPostUrl(handle, (data as any).uri) };
}

function aspect(m: ResolvedMedia) {
  return m.width && m.height ? { width: Math.round(m.width), height: Math.round(m.height) } : undefined;
}

export async function publishToBluesky(handle: string, appPassword: string, content: string, plan: MediaPlan, media: DraftMedia): Promise<PublishResult> {
  if (plan.use === "video") return await publishToBlueskyVideo(handle, appPassword, content, plan.video, media);
  const { accessJwt, did } = await blueskyCreateSession(handle, appPassword);
  let embed: Record<string, unknown> | undefined;
  if (plan.use === "images") {
    const images: unknown[] = [];
    for (const img of plan.images.slice(0, LIMITS.maxImages)) {
      const { bytes, contentType } = await blueskyImageBytes(img, media);
      const resp = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
        method: "POST",
        headers: { "content-type": contentType, "Authorization": `Bearer ${accessJwt}` },
        body: bytes as BodyInit,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error("bluesky_blob_upload_error: " + JSON.stringify(data).slice(0, 300));
      const entry: Record<string, unknown> = { alt: img.alt || "", image: (data as any).blob };
      const ar = aspect(img);
      if (ar) entry.aspectRatio = ar;
      images.push(entry);
    }
    embed = { "$type": "app.bsky.embed.images", images };
  }
  const r = await blueskyCreatePost(handle, accessJwt, did, content, embed);
  return { ok: true, post_id: r.uri, post_url: r.url };
}

async function publishToBlueskyVideo(handle: string, appPassword: string, content: string, video: ResolvedMedia, media: DraftMedia): Promise<PublishResult> {
  const session = await blueskyCreateSession(handle, appPassword);
  const { accessJwt, did } = session;
  const pdsEndpoint = session.didDoc?.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
  const pdsHost = pdsEndpoint ? new URL(pdsEndpoint).hostname : "bsky.social";
  const aud = `did:web:${pdsHost}`;
  const authResp = await fetch(`https://bsky.social/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=com.atproto.repo.uploadBlob&exp=${Math.floor(Date.now() / 1000) + 1800}`, {
    headers: { "Authorization": `Bearer ${accessJwt}` },
  });
  const authData = await authResp.json().catch(() => ({}));
  if (!authResp.ok || !(authData as any).token) throw new Error("bluesky_video_serviceauth_error: " + JSON.stringify(authData).slice(0, 300));
  const serviceToken = (authData as any).token as string;

  let bytes: Uint8Array;
  try { bytes = await media.bytes(video); }
  catch (e) { throw new Error("bluesky_video_fetch_error: could not read the video (" + String((e as Error).message || e).slice(0, 200) + ")"); }
  if (bytes.byteLength > BLUESKY_VIDEO_MAX_BYTES) throw new Error("bluesky_video_too_large: video exceeds Bluesky's 300 MB limit — compress or trim it first");

  const filename = (video.name || "video.mp4").replace(/[^A-Za-z0-9._-]+/g, "_");
  const uploadResp = await fetch(`https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(did)}&name=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "Authorization": `Bearer ${serviceToken}` },
    body: bytes as BodyInit,
  });
  const uploadData: any = await uploadResp.json().catch(() => ({}));
  // 409 already_exists: the same bytes were uploaded before; the job id still resolves to the blob.
  if (!uploadResp.ok && !(uploadResp.status === 409 && uploadData.jobId)) {
    throw new Error("bluesky_video_upload_error: " + JSON.stringify(uploadData).slice(0, 300));
  }
  const jobId = uploadData.jobId as string | undefined;
  let blob = uploadData.blob;
  if (!blob && jobId) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await deps.sleep(1500);
      const st = await fetch(`https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(jobId)}`, { headers: { "Authorization": `Bearer ${serviceToken}` } });
      const sd: any = await st.json().catch(() => ({}));
      if (!st.ok) throw new Error("bluesky_video_jobstatus_error: " + JSON.stringify(sd).slice(0, 300));
      const state = sd.jobStatus?.state;
      if (state === "JOB_STATE_COMPLETED") { blob = sd.jobStatus?.blob; break; }
      if (state === "JOB_STATE_FAILED") throw new Error("bluesky_video_processing_failed: " + JSON.stringify(sd.jobStatus).slice(0, 300));
    }
  }
  if (!blob) throw new Error("bluesky_video_timeout: video was still processing after ~30s — it may still complete; check the account's Bluesky video status manually before retrying");
  const embed: Record<string, unknown> = { "$type": "app.bsky.embed.video", video: blob, alt: video.alt || "" };
  const ar = aspect(video);
  if (ar) embed.aspectRatio = ar;
  const r = await blueskyCreatePost(handle, accessJwt, did, content, embed);
  return { ok: true, post_id: r.uri, post_url: r.url };
}

// ------------------------------------------------------------------ LinkedIn (not live: no client id yet)

export async function publishToLinkedIn(personUrn: string, token: string, content: string, plan: MediaPlan, media: DraftMedia): Promise<PublishResult> {
  const baseHeaders = { "Authorization": `Bearer ${token}`, "LinkedIn-Version": "202401", "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
  let mediaBlock: Record<string, unknown> | undefined;
  if (plan.use === "images") {
    const initResp = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST", headers: baseHeaders, body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } }),
    });
    const initData: any = await initResp.json().catch(() => ({}));
    if (!initResp.ok || !initData.value) throw new Error("linkedin_image_init_error: " + JSON.stringify(initData).slice(0, 300));
    const bytes = await media.bytes(plan.images[0]);
    const up = await fetch(initData.value.uploadUrl, { method: "PUT", body: bytes as BodyInit });
    if (!up.ok) throw new Error("linkedin_image_upload_error: status " + up.status);
    mediaBlock = { media: { title: "", id: initData.value.image } };
  }
  const postBody: Record<string, unknown> = {
    author: personUrn, commentary: content, visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
  };
  if (mediaBlock) postBody.content = mediaBlock;
  const resp = await fetch("https://api.linkedin.com/rest/posts", { method: "POST", headers: baseHeaders, body: JSON.stringify(postBody) });
  if (!resp.ok) throw new Error("linkedin_post_error: " + (await resp.text()).slice(0, 300));
  return { ok: true, post_id: resp.headers.get("x-restli-id") || "posted", note: plan.use === "images" ? plan.note : undefined };
}

// ------------------------------------------------------------------ Pinterest (not live: no client id yet)

export async function publishToPinterest(boardId: string, token: string, content: string, plan: MediaPlan, media: DraftMedia): Promise<PublishResult> {
  if (plan.use !== "images") throw new Error("pinterest_needs_image: Pinterest requires an image with every pin — add one to this draft first.");
  if (!boardId) throw new Error("pinterest_no_board: no board was found on this Pinterest account when it was connected — create a board on Pinterest, then disconnect and reconnect here.");
  const resp = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ board_id: boardId, title: content.slice(0, 100), description: content, media_source: { source_type: "image_url", url: await media.url(plan.images[0]) } }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("pinterest_pin_error: " + JSON.stringify(data).slice(0, 300));
  return { ok: true, post_id: data.id || "posted", note: plan.note };
}

// ------------------------------------------------------------------ TikTok / Discord adapters

function tiktokMediaInput(plan: MediaPlan, media: DraftMedia): TikTokMediaInput | null {
  if (plan.use === "video") {
    const v = plan.video;
    return { video: async () => ({ bytes: await media.bytes(v), contentType: v.mime || "video/mp4" }) };
  }
  if (plan.use === "images") {
    return {
      images: plan.images.map((img) => async () => {
        // Prefer the browser's JPEG copy: smaller to decode inside the edge function's CPU budget.
        if (img.jpegPath) return { bytes: await media.bytes(img, "jpeg"), contentType: "image/jpeg" };
        return { bytes: await media.bytes(img), contentType: img.mime || "image/jpeg" };
      }),
    };
  }
  return null;
}

async function discordPublish(webhookUrl: string, draft: any, plan: MediaPlan, media: DraftMedia, brand: Brand | null): Promise<PublishResult> {
  const common = { content: draft.content, username: brand?.name, avatarUrl: brand?.logo_url };
  let r;
  if (media.set.mode === "upload") {
    const items = plan.use === "images" ? plan.images : plan.use === "video" ? [plan.video] : [];
    const files: DiscordFile[] = [];
    for (const it of items) files.push({ name: it.name, bytes: await media.bytes(it), contentType: String(it.mime) });
    r = await publishToDiscord(webhookUrl, { ...common, files });
  } else {
    // Legacy URL fields: unchanged behaviour (image embeds + video link).
    r = await publishToDiscord(webhookUrl, { ...common, imageUrls: collectDiscordImages(draft), videoUrl: draft.video_url });
  }
  return { ok: true, post_id: r.post_id, message_ids: r.message_ids, note: r.note };
}

// ------------------------------------------------------------------ dispatcher

export type Brand = { name?: string; logo_url?: string };

export async function loadBrand(svc: any, draft: any): Promise<Brand | null> {
  const { data } = await svc.from("cubicles").select("name, logo_url").eq("id", draft.cubicle_id).eq("user_id", draft.user_id).maybeSingle();
  return data || null;
}

export async function publishToAccounts(svc: any, draft: any, accounts: any[], media: DraftMedia): Promise<Record<string, PublishResult>> {
  const results: Record<string, PublishResult> = {};
  const brand = accounts.some((a) => a.platform === "discord") ? await loadBrand(svc, draft) : null;
  for (const acct of accounts) {
    const plan = planMedia(acct.platform, media.set);
    if (plan.use === "skip") { results[acct.platform] = { ok: false, skipped: true, error: plan.reason }; continue; }
    try {
      switch (acct.platform) {
        case "facebook": results.facebook = await publishToFacebook(acct.external_account_id, acct.access_token, draft.content, plan, media); break;
        case "instagram": results.instagram = await publishToInstagram(acct.external_account_id, acct.access_token, draft.content, plan, media); break;
        case "bluesky": results.bluesky = await publishToBluesky(acct.external_account_name, acct.access_token, draft.content, plan, media); break;
        case "linkedin": results.linkedin = await publishToLinkedIn(acct.external_account_id, acct.access_token, draft.content, plan, media); break;
        case "pinterest": results.pinterest = await publishToPinterest(acct.external_account_id, acct.access_token, draft.content, plan, media); break;
        case "tiktok": {
          const r = await publishToTikTokFull(svc, acct, draft, tiktokMediaInput(plan, media));
          results.tiktok = { ok: true, post_id: r.publish_id, status: r.status, note: r.note };
          break;
        }
        case "discord": results.discord = await discordPublish(acct.access_token, draft, plan, media, brand); break;
        default: break;
      }
    } catch (e) {
      const permanent = e instanceof MediaError && e.permanent;
      results[acct.platform] = { ok: false, error: String(e), ...(permanent ? { skipped: true } : {}) };
    }
  }
  return results;
}

export function summarize(results: Record<string, PublishResult>) {
  const vals = Object.values(results);
  const anySucceeded = vals.some((r) => r.ok);
  const onlySkips = vals.length > 0 && vals.every((r) => !r.ok && r.skipped);
  const allErrors = Object.entries(results).filter(([, r]) => !r.ok).map(([p, r]) => `${p}: ${r.error}`).join(" | ");
  const order = ["facebook", "instagram", "bluesky", "linkedin", "tiktok", "pinterest", "discord"];
  const firstPostId = order.map((p) => results[p]?.ok ? results[p]?.post_id : null).find(Boolean) || null;
  return { anySucceeded, onlySkips, allErrors, firstPostId };
}
