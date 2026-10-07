// Shared media rules + helpers for BrandParent publishers (publish-post and
// cron-publish-scheduled). Keep the numbers in sync with js/media-rules.js
// (a unit test asserts they match).
//
// Storage model
// - Files live in the PRIVATE Supabase Storage bucket `post-media` at
//   {user_id}/{cubicle_id}/{random}.{png|jpg|jpeg|mp4}. RLS lets a user insert,
//   read and delete only under their own user_id folder (and only for a cubicle
//   they own). Nothing in the bucket is publicly readable.
// - drafts.media (jsonb array) holds the references. A DB CHECK constraint
//   (post_media_is_valid) rejects paths outside the draft owner's folder.
// - At publish time the edge function (service role) downloads the bytes for
//   platforms that take uploads (Bluesky, Discord, TikTok video, LinkedIn) and
//   mints short-lived signed URLs (24h) for platforms that must pull a URL
//   (Facebook, Instagram, Pinterest). TikTok photos are re-staged into the
//   existing public `tiktok-media` bucket because TikTok only pulls from the
//   verified brandparent.app domain.

export const MEDIA_BUCKET = "post-media";

export const LIMITS = {
  maxImages: 4,                    // Bluesky max 4 per post; Discord/IG/FB/TikTok allow more
  maxVideos: 1,                    // one video per post; images and video can't be mixed
  imageMaxBytes: 8_000_000,        // Instagram: JPEG <= 8 MB (FB 10 MB, Discord 10 MiB, TikTok 20 MB)
  videoMaxBytes: 50_000_000,       // 50 MB (just under the project-wide 50 MiB Storage upload limit); "short video"
  videoMaxSeconds: 90,             // BrandParent's definition of a short video
  videoMinSeconds: 1,
  blueskyImageMaxBytes: 1_000_000, // app.bsky.embed.images blob maxSize
  discordUploadMaxBytes: 10_000_000, // per message on servers without boosts (L2 50 MB, L3 100 MB); conservative
  instagramVideoMinSeconds: 3,     // Reels: 3 s .. 15 min
  instagramAspectMin: 4 / 5,       // feed images 4:5 .. 1.91:1
  instagramAspectMax: 1.91,
  signedUrlTtlSeconds: 24 * 3600,  // long enough for Meta to fetch + process a Reel
} as const;

export const ALLOWED_MIME = ["image/png", "image/jpeg", "video/mp4"] as const;
export type MediaMime = typeof ALLOWED_MIME[number];
export type MediaKind = "image" | "video";

/** Shape stored in drafts.media (written by the browser, re-validated here). */
export type StoredMedia = {
  path: string;
  kind: MediaKind;
  mime: MediaMime;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  name?: string;
  alt?: string;
  /** optional browser-made JPEG copy (<= ~1 MB) for Bluesky / Instagram */
  jpeg_path?: string;
  jpeg_size?: number;
};

export class MediaError extends Error {
  code: string;
  permanent: boolean;
  constructor(code: string, message: string, permanent = true) {
    super(`${code}: ${message}`);
    this.code = code;
    this.permanent = permanent;
  }
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.(png|jpg|jpeg|mp4)$/;
const EXT_MIME: Record<string, MediaMime> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", mp4: "video/mp4" };

export function mimeForPath(path: string): MediaMime | null {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return EXT_MIME[ext] || null;
}

/** True if `path` is exactly {userId}/{cubicleId}/{safe file name}. */
export function isOwnedPath(path: unknown, userId: string, cubicleId: string): path is string {
  if (typeof path !== "string") return false;
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === String(userId) && parts[1] === String(cubicleId) && FILE_RE.test(parts[2]);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Validates drafts.media. Throws MediaError (permanent) on anything off.
 * Server-side twin of the browser checks; never trust the browser's numbers for
 * enforcement (prepare() re-checks real bytes), but do reject bad shapes early.
 */
export function validateStoredMedia(raw: unknown, userId: string, cubicleId: string): StoredMedia[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new MediaError("media_invalid", "media must be a list.");
  if (raw.length === 0) return [];
  const out: StoredMedia[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") throw new MediaError("media_invalid", "media entry is not an object.");
    const m = r as Record<string, unknown>;
    if (!isOwnedPath(m.path, userId, cubicleId)) {
      throw new MediaError("media_forbidden_path", "a media file doesn't belong to this brand's folder.");
    }
    const mime = mimeForPath(m.path as string)!;
    const kind: MediaKind = mime.startsWith("video/") ? "video" : "image";
    if (m.kind !== undefined && m.kind !== kind) throw new MediaError("media_invalid", "media kind doesn't match the file type.");
    if (m.mime !== undefined && m.mime !== mime) throw new MediaError("media_unsupported_type", "only PNG, JPEG and MP4 files are supported.");
    const size = num(m.size) ?? 0;
    const cap = kind === "video" ? LIMITS.videoMaxBytes : LIMITS.imageMaxBytes;
    if (size > cap) throw new MediaError("media_too_large", `${kind === "video" ? "videos" : "images"} must be ${fmtBytes(cap)} or smaller.`);
    const item: StoredMedia = { path: m.path as string, kind, mime, size };
    for (const k of ["width", "height", "duration", "jpeg_size"] as const) { const v = num(m[k]); if (v !== undefined) item[k] = v; }
    if (typeof m.name === "string") item.name = m.name.slice(0, 120);
    if (typeof m.alt === "string") item.alt = m.alt.slice(0, 1000);
    if (m.jpeg_path !== undefined && m.jpeg_path !== null) {
      if (!isOwnedPath(m.jpeg_path, userId, cubicleId) || mimeForPath(m.jpeg_path as string) !== "image/jpeg" || kind !== "image") {
        throw new MediaError("media_forbidden_path", "a media copy doesn't belong to this brand's folder.");
      }
      item.jpeg_path = m.jpeg_path as string;
    }
    out.push(item);
  }
  const videos = out.filter((m) => m.kind === "video").length;
  const images = out.length - videos;
  if (videos > LIMITS.maxVideos) throw new MediaError("media_too_many", "only one video per post.");
  if (videos && images) throw new MediaError("media_mixed", "a post can have images or a video, not both.");
  if (images > LIMITS.maxImages) throw new MediaError("media_too_many", `up to ${LIMITS.maxImages} images per post.`);
  return out;
}

export function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10} MB`;
  if (n >= 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} bytes`;
}

// ---------------------------------------------------------------- sniffing

export function sniffMime(b: Uint8Array): MediaMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4"; // 'ftyp'
  return null;
}

/** Width/height from a PNG IHDR or JPEG SOF header (no decode). EXIF rotation is not applied. */
export function imageDims(b: Uint8Array): { width: number; height: number } | null {
  const mime = sniffMime(b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mime === "image/png" && b.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Duration (seconds) from an MP4/ISO-BMFF moov/mvhd box, plus whether moov precedes mdat ("faststart"). */
export function mp4Info(b: Uint8Array): { duration: number | null; moovFirst: boolean | null } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const readBox = (off: number, end: number) => {
    if (off + 8 > end) return null;
    let size = dv.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return null;
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header) return null;
    return { type, start: off, header, end: Math.min(off + size, end) };
  };
  let off = 0, moovAt = -1, mdatAt = -1, duration: number | null = null;
  while (off < b.length) {
    const box = readBox(off, b.length);
    if (!box) break;
    if (box.type === "mdat" && mdatAt < 0) mdatAt = box.start;
    if (box.type === "moov" && moovAt < 0) {
      moovAt = box.start;
      let c = box.start + box.header;
      while (c < box.end) {
        const child = readBox(c, box.end);
        if (!child) break;
        if (child.type === "mvhd") {
          const p = child.start + child.header;
          const version = b[p];
          let timescale: number, dur: number;
          if (version === 1) { timescale = dv.getUint32(p + 20); dur = Number(dv.getBigUint64(p + 24)); }
          else { timescale = dv.getUint32(p + 12); dur = dv.getUint32(p + 16); }
          if (timescale > 0) duration = dur / timescale;
          break;
        }
        c = child.end;
      }
    }
    off = box.end;
  }
  return { duration, moovFirst: moovAt >= 0 && mdatAt >= 0 ? moovAt < mdatAt : null };
}

/** Real-bytes check for one uploaded file. Throws MediaError (permanent). */
export function checkBytes(item: { kind: MediaKind; mime: MediaMime; name?: string }, bytes: Uint8Array): { duration?: number; width?: number; height?: number; moovFirst?: boolean | null } {
  const sniffed = sniffMime(bytes);
  const label = item.name ? `"${item.name}"` : "a file";
  if (sniffed !== item.mime) throw new MediaError("media_type_mismatch", `${label} isn't really a ${item.mime.split("/")[1].toUpperCase()} file.`);
  if (item.kind === "image") {
    if (bytes.byteLength > LIMITS.imageMaxBytes) throw new MediaError("media_too_large", `${label} is ${fmtBytes(bytes.byteLength)}; images must be ${fmtBytes(LIMITS.imageMaxBytes)} or smaller.`);
    return imageDims(bytes) || {};
  }
  if (bytes.byteLength > LIMITS.videoMaxBytes) throw new MediaError("media_too_large", `${label} is ${fmtBytes(bytes.byteLength)}; videos must be ${fmtBytes(LIMITS.videoMaxBytes)} or smaller.`);
  const info = mp4Info(bytes);
  if (info.duration == null) throw new MediaError("media_unreadable_video", `${label} couldn't be read as an MP4 video.`);
  if (info.duration > LIMITS.videoMaxSeconds + 0.5) throw new MediaError("media_too_long", `${label} is ${Math.round(info.duration)}s; videos must be ${LIMITS.videoMaxSeconds}s or shorter.`);
  if (info.duration < LIMITS.videoMinSeconds) throw new MediaError("media_too_short", `${label} is shorter than ${LIMITS.videoMinSeconds}s.`);
  return { duration: info.duration, moovFirst: info.moovFirst };
}

// ---------------------------------------------------------------- resolution

export type ResolvedMedia = {
  kind: MediaKind;
  mime: MediaMime | string;
  source: "upload" | "url";
  path?: string;          // storage path (upload)
  url?: string;           // external URL (legacy URL fields)
  jpegPath?: string;
  name: string;
  alt: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  moovFirst?: boolean | null;
};

export type MediaSet = { mode: "upload" | "url" | "none"; images: ResolvedMedia[]; video: ResolvedMedia | null };

type Svc = { storage: { from: (b: string) => any } };

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string" || !s.trim()) return false;
  try { const u = new URL(s.trim()); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

/**
 * Everything a publisher needs to get at a draft's media. Uploaded files
 * (drafts.media) take precedence; the legacy image_url / video_url fields are
 * used only when nothing was uploaded. Downloads are cached per request so a
 * 50 MB video is fetched once even when several platforms need it.
 */
export class DraftMedia {
  set: MediaSet;
  private cache = new Map<string, Promise<Uint8Array>>();
  private signed = new Map<string, Promise<string>>();
  constructor(private svc: Svc, private draft: any, private fetchFn: typeof fetch = fetch) {
    const stored = validateStoredMedia(draft.media, draft.user_id, draft.cubicle_id);
    if (stored.length) {
      const res = stored.map((m, i): ResolvedMedia => ({
        kind: m.kind, mime: m.mime, source: "upload", path: m.path, jpegPath: m.jpeg_path,
        name: m.name || m.path.split("/").pop() || `file${i + 1}`, alt: m.alt || "",
        size: m.size, width: m.width, height: m.height, duration: m.duration,
      }));
      this.set = { mode: "upload", images: res.filter((r) => r.kind === "image"), video: res.find((r) => r.kind === "video") || null };
    } else {
      const images: ResolvedMedia[] = isHttpUrl(draft.image_url)
        ? [{ kind: "image", mime: "", source: "url", url: draft.image_url.trim(), name: "image", alt: "" }] : [];
      const video: ResolvedMedia | null = isHttpUrl(draft.video_url)
        ? { kind: "video", mime: "", source: "url", url: draft.video_url.trim(), name: "video.mp4", alt: "" } : null;
      this.set = { mode: images.length || video ? "url" : "none", images, video };
    }
  }

  get hasAny(): boolean { return this.set.images.length > 0 || !!this.set.video; }

  /** Downloads and checks every uploaded file once (type sniff, size, duration). */
  async prepare(): Promise<void> {
    if (this.set.mode !== "upload") return;
    for (const item of [...this.set.images, ...(this.set.video ? [this.set.video] : [])]) {
      const bytes = await this.bytes(item);
      const info = checkBytes({ kind: item.kind, mime: item.mime as MediaMime, name: item.name }, bytes);
      item.size = bytes.byteLength;
      if (info.duration !== undefined) item.duration = info.duration;
      if (info.moovFirst !== undefined) item.moovFirst = info.moovFirst;
      if (!item.width && info.width) { item.width = info.width; item.height = info.height; }
    }
  }

  private async download(path: string): Promise<Uint8Array> {
    const { data, error } = await this.svc.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) {
      const msg = String(error?.message || error || "not found");
      const missing = /not.?found|404|does not exist/i.test(msg);
      throw new MediaError(missing ? "media_missing" : "media_download_failed",
        missing ? "an uploaded file is gone from storage — remove it from the post and upload it again." : `couldn't read an uploaded file (${msg.slice(0, 120)}).`,
        missing);
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  /** Bytes of the original (or the browser-made JPEG copy when variant = "jpeg"). */
  bytes(item: ResolvedMedia, variant: "original" | "jpeg" = "original"): Promise<Uint8Array> {
    const key = variant === "jpeg" ? `j:${item.jpegPath}` : `o:${item.path || item.url}`;
    let p = this.cache.get(key);
    if (!p) {
      if (variant === "jpeg") {
        if (!item.jpegPath) throw new Error("no jpeg copy");
        p = this.download(item.jpegPath).then((b) => {
          if (sniffMime(b) !== "image/jpeg") throw new MediaError("media_type_mismatch", "the JPEG copy of an image is not a JPEG.");
          return b;
        });
      } else if (item.source === "upload") {
        p = this.download(item.path!);
      } else {
        p = (async () => {
          const r = await this.fetchFn(item.url!);
          if (!r.ok) throw new MediaError(`${item.kind}_fetch_error`, `couldn't download the ${item.kind} URL (HTTP ${r.status}).`, false);
          if (!item.mime) item.mime = r.headers.get("content-type") || (item.kind === "video" ? "video/mp4" : "image/jpeg");
          return new Uint8Array(await r.arrayBuffer());
        })();
      }
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  /** A URL a platform's servers can fetch: the original URL (legacy) or a 24h signed Storage URL. */
  url(item: ResolvedMedia, variant: "original" | "jpeg" = "original"): Promise<string> {
    if (item.source === "url") return Promise.resolve(item.url!);
    const path = variant === "jpeg" ? item.jpegPath! : item.path!;
    return this.signPath(path);
  }

  signPath(path: string): Promise<string> {
    let p = this.signed.get(path);
    if (!p) {
      p = (async () => {
        const { data, error } = await this.svc.storage.from(MEDIA_BUCKET).createSignedUrl(path, LIMITS.signedUrlTtlSeconds);
        if (error || !data?.signedUrl) throw new MediaError("media_sign_failed", `couldn't create a link for an uploaded file (${String(error?.message || error).slice(0, 120)}).`, false);
        return data.signedUrl as string;
      })();
      this.signed.set(path, p);
      p.catch(() => this.signed.delete(path));
    }
    return p;
  }

  /** Server-side helper to store a derived file (e.g. JPEG for Instagram) next to the original and sign it. */
  async storeDerived(item: ResolvedMedia, suffix: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const base = (item.path || "x/x/file").replace(/\.[a-z0-9]+$/i, "");
    const path = `${base}-${suffix}`;
    const { error } = await this.svc.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (error) throw new MediaError("media_stage_failed", `couldn't save a converted copy (${String(error.message || error).slice(0, 120)}).`, false);
    return this.signPath(path);
  }
}

// ---------------------------------------------------------------- per-platform plan

export type Platform = "bluesky" | "facebook" | "instagram" | "tiktok" | "discord" | "linkedin" | "pinterest" | "tumblr" | string;

export type MediaPlan =
  | { use: "none" }
  | { use: "images"; images: ResolvedMedia[]; note?: string }
  | { use: "video"; video: ResolvedMedia; note?: string }
  | { use: "images+video"; images: ResolvedMedia[]; video: ResolvedMedia } // legacy URL mode on Discord only
  | { use: "skip"; reason: string };

const LABEL: Record<string, string> = {
  bluesky: "Bluesky", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok",
  discord: "Discord", linkedin: "LinkedIn", pinterest: "Pinterest", tumblr: "Tumblr",
};

/**
 * Decides which of the draft's media each platform gets, or why it is skipped.
 * Upload mode never mixes images + video (validated). URL mode keeps the old
 * behaviour: FB/IG/LinkedIn/Pinterest use the image, Bluesky/TikTok prefer the
 * video, Discord gets both.
 */
export function planMedia(platform: Platform, set: MediaSet): MediaPlan {
  const { images, video } = set;
  const L = LABEL[platform] || platform;
  switch (platform) {
    case "bluesky":
      if (video) return { use: "video", video };
      if (images.length) return { use: "images", images: images.slice(0, LIMITS.maxImages) };
      return { use: "none" };
    case "tiktok":
      if (video) return { use: "video", video };
      if (images.length) return { use: "images", images };
      return { use: "skip", reason: "tiktok_needs_media: TikTok posts need a photo or video — add one to this draft first." };
    case "instagram":
      if (images.length) {
        if (set.mode === "upload") {
          const bad = images.find((i) => i.width && i.height && (i.width / i.height < LIMITS.instagramAspectMin - 0.005 || i.width / i.height > LIMITS.instagramAspectMax + 0.005));
          if (bad) return { use: "skip", reason: `instagram_aspect_ratio: Instagram only accepts images between 4:5 (portrait) and 1.91:1 (landscape); "${bad.name}" is ${bad.width}×${bad.height}. Crop it or uncheck Instagram.` };
        }
        return { use: "images", images: set.mode === "url" ? images.slice(0, 1) : images };
      }
      if (video && set.mode === "upload") {
        if (video.duration !== undefined && video.duration < LIMITS.instagramVideoMinSeconds) {
          return { use: "skip", reason: `instagram_video_too_short: Instagram Reels must be at least ${LIMITS.instagramVideoMinSeconds} seconds long.` };
        }
        return { use: "video", video };
      }
      return { use: "skip", reason: "instagram_needs_image: Instagram requires an image or video with every post — add one to this draft first." };
    case "facebook":
      if (images.length) return { use: "images", images: set.mode === "url" ? images.slice(0, 1) : images };
      if (video && set.mode === "upload") return { use: "video", video };
      return { use: "none" };
    case "discord":
      if (set.mode === "url") {
        if (images.length && video) return { use: "images+video", images, video };
        if (video) return { use: "video", video };
        if (images.length) return { use: "images", images };
        return { use: "none" };
      }
      if (video) return { use: "video", video };
      if (images.length) return { use: "images", images };
      return { use: "none" };
    case "linkedin":
      if (images.length) return { use: "images", images: images.slice(0, 1), note: images.length > 1 ? "LinkedIn got the first image only" : undefined };
      if (video && set.mode === "upload") return { use: "skip", reason: `linkedin_video_unsupported: ${L} video posting isn't supported in BrandParent yet — uncheck ${L} or attach an image instead.` };
      return { use: "none" };
    case "pinterest":
      if (images.length) return { use: "images", images: images.slice(0, 1), note: images.length > 1 ? "Pinterest got the first image only" : undefined };
      if (video && set.mode === "upload") return { use: "skip", reason: `pinterest_video_unsupported: ${L} video pins aren't supported in BrandParent yet — attach an image or uncheck ${L}.` };
      return { use: "skip", reason: "pinterest_needs_image: Pinterest requires an image with every pin — add one to this draft first." };
    case "tumblr":
      // Upload mode: native video (multipart) or up to 30 images. URL mode: image first, else link the video.
      if (video && (set.mode === "upload" || !images.length)) return { use: "video", video };
      if (images.length) return { use: "images", images: set.mode === "url" ? images.slice(0, 1) : images };
      return { use: "none" };
    default:
      return { use: "none" };
  }
}
