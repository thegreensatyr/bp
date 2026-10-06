// Shared Discord helpers for BrandParent edge functions.
//
// Discord is connected per cubicle by pasting a channel webhook URL
// (Server Settings > Integrations > Webhooks > New Webhook > Copy URL).
// The full webhook URL is a bearer credential: anyone holding it can post to
// that channel. It is stored server-side only (social_accounts.access_token)
// and must never be returned to the browser or written to logs.

export const DISCORD_MAX_CONTENT = 2000;   // Discord's per-message content limit
export const DISCORD_MAX_IMAGES = 4;       // BrandParent's per-post image cap
export const DISCORD_MAX_MESSAGES = 5;     // cap for long posts split into chunks
export const DISCORD_MAX_UPLOAD = 10_000_000; // per message on servers without boosts (Level 2: 50 MB, Level 3: 100 MB); conservative
export const DISCORD_MAX_FILES = 10;       // attachments per message

export type DiscordFile = { name: string; bytes: Uint8Array; contentType: string };

/** Packs files into groups whose total size stays under `max` (a single oversize file gets its own group). */
export function packDiscordFiles(files: DiscordFile[], max = DISCORD_MAX_UPLOAD): DiscordFile[][] {
  const groups: DiscordFile[][] = [];
  let cur: DiscordFile[] = [], curSize = 0;
  for (const f of files) {
    const n = f.bytes.byteLength;
    if (cur.length && (curSize + n > max || cur.length >= DISCORD_MAX_FILES)) { groups.push(cur); cur = []; curSize = 0; }
    cur.push(f); curSize += n;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function safeFileName(name: string, i: number): string {
  const ext = (name.match(/\.(png|jpe?g|mp4)$/i)?.[0] || "").toLowerCase();
  const base = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || `file${i + 1}`;
  return base + ext;
}

const WEBHOOK_RE = /^https:\/\/discord\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,120})\/?$/;

export type ParsedWebhook = { id: string; token: string; url: string };

/** Validates and canonicalises a Discord webhook URL. Only https://discord.com/api/webhooks/... is accepted. */
export function parseDiscordWebhookUrl(raw: unknown): ParsedWebhook | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length > 300) return null;
  let u: URL;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "discord.com" || u.port !== "" || u.username || u.password) return null;
  // Ignore query/hash (e.g. ?wait=true or ?thread_id=) – we only keep the canonical form.
  const m = WEBHOOK_RE.exec(`https://discord.com${u.pathname}`);
  if (!m) return null;
  const [, id, token] = m;
  return { id, token, url: `https://discord.com/api/webhooks/${id}/${token}` };
}

/** Splits text into chunks of at most `max` chars, preferring paragraph, line, sentence, then word boundaries. */
export function splitForDiscord(text: string, max = DISCORD_MAX_CONTENT): string[] {
  const out: string[] = [];
  let rest = (text || "").trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const sep of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
      const i = window.lastIndexOf(sep);
      if (i >= max * 0.5) { cut = i + (sep === " " || sep.startsWith("\n") ? 0 : 1); break; }
    }
    if (cut <= 0) cut = max; // no good boundary: hard cut
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out.push(rest);
  return out;
}

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try { const u = new URL(s.trim()); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

/** Collects up to 4 image URLs: the draft's main image_url plus platform_options.discord.extra_image_urls. */
export function collectDiscordImages(draft: { image_url?: string | null; platform_options?: any }): string[] {
  const list: string[] = [];
  if (isHttpUrl(draft.image_url)) list.push(draft.image_url!.trim());
  const extra = draft.platform_options?.discord?.extra_image_urls;
  if (Array.isArray(extra)) for (const e of extra) if (isHttpUrl(e)) list.push(e.trim());
  return [...new Set(list)].slice(0, DISCORD_MAX_IMAGES);
}

function safeUsername(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const n = name.trim().slice(0, 80);
  // Discord rejects webhook usernames containing these substrings.
  if (!n || /discord|clyde/i.test(n) || n === "everyone" || n === "here") return undefined;
  return n;
}

async function postOnce(url: string, payload: Record<string, unknown>, files?: DiscordFile[]): Promise<Response> {
  if (files && files.length) {
    const form = new FormData();
    const names = files.map((f, i) => safeFileName(f.name, i));
    form.append("payload_json", JSON.stringify({ ...payload, attachments: names.map((filename, id) => ({ id, filename })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes as BlobPart], { type: f.contentType }), names[i]));
    return await fetch(`${url}?wait=true`, { method: "POST", body: form });
  }
  return await fetch(`${url}?wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function postWithRetry(url: string, payload: Record<string, unknown>, files?: DiscordFile[]) {
  let resp = await postOnce(url, payload, files);
  if (resp.status === 429) {
    const body = await resp.json().catch(() => ({}));
    const waitMs = Math.min(Math.ceil(((body as any).retry_after ?? 1) * 1000), 10_000);
    await new Promise((r) => setTimeout(r, waitMs));
    resp = await postOnce(url, payload, files);
  }
  return resp;
}

/**
 * Publishes a post to a Discord channel webhook.
 * - Text longer than 2000 chars is split into up to 5 messages (beyond that it is truncated).
 * - Up to 4 images are attached as embeds on the last message (same embed url => Discord renders a gallery).
 * - A video_url is appended as a link so Discord unfurls it.
 * - Uploaded files (opts.files: PNG/JPEG/MP4 bytes from post-media) are sent as
 *   real attachments (multipart), packed into messages of <= 10 MB each.
 * - Mentions are disabled so post text can never ping @everyone/@here/roles.
 * Never include the webhook URL in thrown errors.
 */
export async function publishToDiscord(
  webhookUrl: string,
  opts: { content: string; imageUrls?: string[]; videoUrl?: string | null; username?: string | null; avatarUrl?: string | null; files?: DiscordFile[] },
): Promise<{ post_id: string; message_ids: string[]; note?: string }> {
  const parsed = parseDiscordWebhookUrl(webhookUrl);
  if (!parsed) throw new Error("discord_bad_webhook: the stored Discord webhook is invalid — disconnect and reconnect Discord for this cubicle.");

  let text = (opts.content || "").trim();
  if (isHttpUrl(opts.videoUrl)) text = text ? `${text}\n\n${opts.videoUrl!.trim()}` : opts.videoUrl!.trim();
  const images = (opts.imageUrls || []).filter(isHttpUrl).slice(0, DISCORD_MAX_IMAGES);
  const fileGroups = packDiscordFiles(opts.files || []);
  if (!text && images.length === 0 && fileGroups.length === 0) throw new Error("discord_empty: nothing to post (no text or images).");

  let chunks = text ? splitForDiscord(text) : [""];
  let note: string | undefined;
  if (chunks.length > DISCORD_MAX_MESSAGES) {
    chunks = chunks.slice(0, DISCORD_MAX_MESSAGES);
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = last.slice(0, DISCORD_MAX_CONTENT - 1) + "…";
    note = `post was longer than ${DISCORD_MAX_MESSAGES * DISCORD_MAX_CONTENT} characters and was truncated`;
  } else if (chunks.length > 1) {
    note = `split into ${chunks.length} messages (Discord's limit is ${DISCORD_MAX_CONTENT} characters each)`;
  }

  const base: Record<string, unknown> = { allowed_mentions: { parse: [] } };
  const username = safeUsername(opts.username);
  if (username) base.username = username;
  if (isHttpUrl(opts.avatarUrl)) base.avatar_url = opts.avatarUrl!.trim();

  const galleryUrl = images[0];
  const embeds = images.map((u) => ({ url: galleryUrl, image: { url: u } }));

  // One request per text chunk; the last chunk carries the URL embeds and the
  // first group of attachments; any further attachment groups follow on their own.
  const sends: Array<{ content: string; embeds: boolean; files?: DiscordFile[] }> = chunks.map((c, i) => ({
    content: c, embeds: i === chunks.length - 1, files: i === chunks.length - 1 ? fileGroups[0] : undefined,
  }));
  for (const g of fileGroups.slice(1)) sends.push({ content: "", embeds: false, files: g });

  const ids: string[] = [];
  for (let i = 0; i < sends.length; i++) {
    const isLast = i === sends.length - 1;
    const payload: Record<string, unknown> = { ...base };
    if (sends[i].content) payload.content = sends[i].content;
    if (sends[i].embeds && embeds.length) payload.embeds = embeds;

    const resp = await postWithRetry(parsed.url, payload, sends[i].files);
    if (!resp.ok) {
      const errText = (await resp.text().catch(() => "")).slice(0, 300);
      const tooBig = resp.status === 413 || /entity too large|file.*too large|40005/i.test(errText);
      const reason = resp.status === 404 || resp.status === 401
        ? "discord_webhook_gone: this webhook was deleted or revoked in Discord — create a new one and reconnect Discord for this cubicle."
        : tooBig
        ? `discord_file_too_large: Discord rejected the attachment as too large — servers without boosts accept up to ${DISCORD_MAX_UPLOAD / 1_000_000} MB per message (Level 2: 50 MB, Level 3: 100 MB). Use a smaller file or uncheck Discord.`
        : `discord_post_error (HTTP ${resp.status}): ${errText}`;
      if (ids.length) {
        // Some chunks already went out. Report success-with-warning so the
        // scheduler does not retry and duplicate the messages that were sent.
        return { post_id: ids[0], message_ids: ids, note: `only ${ids.length} of ${sends.length} messages were sent — ${reason}` };
      }
      throw new Error(reason);
    }
    const msg = await resp.json().catch(() => ({}));
    if ((msg as any).id) ids.push(String((msg as any).id));
    if (!isLast) await new Promise((r) => setTimeout(r, 400)); // stay well inside webhook rate limits
  }
  return { post_id: ids[0] || "posted", message_ids: ids, note };
}
