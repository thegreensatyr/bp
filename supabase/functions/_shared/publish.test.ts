// Per-platform media handling with mocked platform APIs and a mocked service client.
// Run: deno test --allow-read --allow-net=deno.land supabase/functions/_shared/
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { deps, publishToAccounts, summarize, toJpegUnder } from "./publish.ts";
import { DraftMedia, LIMITS } from "./media.ts";
import { CID, fakeMp4, jpeg, json, mockFetch, mockSvc, P, png, UID } from "./test_helpers.ts";

deps.sleep = async () => {}; // no real waiting in polls

const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"t".repeat(60)}`;
const acct = (platform: string, extra: Record<string, unknown> = {}) => ({
  id: `acct-${platform}`, platform, user_id: UID, cubicle_id: CID,
  external_account_id: platform === "facebook" ? "PAGE1" : platform === "instagram" ? "IG1" : "ext",
  external_account_name: "brand.bsky.social", access_token: platform === "discord" ? WEBHOOK : "tok",
  token_expires_at: new Date(Date.now() + 86400_000).toISOString(), ...extra,
});
const imgItem = (f: string, size: number, extra: Record<string, unknown> = {}) => ({ path: P(f), kind: "image", mime: f.endsWith(".png") ? "image/png" : "image/jpeg", size, name: f, width: 1080, height: 1080, ...extra });
const vidItem = (f: string, size: number, extra: Record<string, unknown> = {}) => ({ path: P(f), kind: "video", mime: "video/mp4", size, name: f, duration: 20, width: 1080, height: 1920, ...extra });

async function run(draftExtra: Record<string, unknown>, files: Record<string, Uint8Array>, accounts: any[], routes: Parameters<typeof mockFetch>[0]) {
  const svc = mockSvc(Object.fromEntries(Object.entries(files).map(([k, v]) => [`post-media/${P(k)}`, v])));
  const draft = { id: "d1", user_id: UID, cubicle_id: CID, content: "Hello from the brand", media: [], platform_options: { tiktok: { privacy_level: "SELF_ONLY" } }, ...draftExtra };
  const m = mockFetch(routes);
  try {
    const media = new DraftMedia(svc, draft);
    await media.prepare();
    const results = await publishToAccounts(svc, draft, accounts, media);
    return { results, calls: m.calls, svc };
  } finally { m.restore(); }
}

const bskyRoutes = (blobs: Array<{ type: string; size: number }>): Parameters<typeof mockFetch>[0] => [
  ["createSession", () => json({ accessJwt: "jwt", did: "did:plc:abc", handle: "brand.bsky.social", didDoc: { service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example.com" }] } })],
  ["getServiceAuth", () => json({ token: "svc" })], // before uploadBlob: its query string mentions uploadBlob
  ["uploadBlob", async (c) => { blobs.push({ type: c.headers.get("content-type")!, size: (c.body as Uint8Array).byteLength }); return json({ blob: { $type: "blob", ref: { $link: "cid" + blobs.length }, mimeType: c.headers.get("content-type"), size: 1 } }); }],
  ["createRecord", () => json({ uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz", cid: "c" })],
  ["uploadVideo", () => json({ jobId: "job1", state: "JOB_STATE_CREATED" })],
  ["getJobStatus", () => json({ jobStatus: { state: "JOB_STATE_COMPLETED", blob: { $type: "blob", ref: { $link: "vid" } } } })],
];
const bodyOf = (calls: any[], part: string) => JSON.parse(calls.find((c) => c.url.includes(part))!.body);

// ------------------------------------------------------------ Bluesky

Deno.test("bluesky: small PNG goes up as-is; >1 MB image uses the browser's JPEG copy; 4-image embed with aspect ratios", async () => {
  const small = await png(400, 300);
  const big = new Uint8Array(1_500_000); big.set(await jpeg(8, 8)); // looks like a JPEG, 1.5 MB
  const copy = await jpeg(1000, 1000);
  const blobs: any[] = [];
  const { results, calls } = await run(
    { media: [imgItem("a.png", small.length, { width: 400, height: 300, alt: "A cat" }), imgItem("b.jpg", big.length, { jpeg_path: P("b-web.jpg"), jpeg_size: copy.length }), imgItem("c.png", small.length), imgItem("d.png", small.length)] },
    { "a.png": small, "b.jpg": big, "b-web.jpg": copy, "c.png": small, "d.png": small },
    [acct("bluesky")], bskyRoutes(blobs));
  assert(results.bluesky.ok, results.bluesky.error);
  assertEquals(results.bluesky.post_url, "https://bsky.app/profile/brand.bsky.social/post/3kxyz");
  assertEquals(blobs.length, 4);
  assertEquals(blobs[0], { type: "image/png", size: small.length });
  assertEquals(blobs[1], { type: "image/jpeg", size: copy.length });
  assert(blobs.every((b) => b.size <= LIMITS.blueskyImageMaxBytes));
  const rec = bodyOf(calls, "createRecord").record;
  assertEquals(rec.embed.$type, "app.bsky.embed.images");
  assertEquals(rec.embed.images.length, 4);
  assertEquals(rec.embed.images[0].alt, "A cat");
  assertEquals(rec.embed.images[0].aspectRatio, { width: 400, height: 300 });
});

Deno.test("bluesky: >1 MB image without a copy is shrunk server-side under 1 MB", async () => {
  const noisy = await png(900, 900, true);
  assert(noisy.length > 1_000_000, `fixture ${noisy.length}`);
  const blobs: any[] = [];
  const { results } = await run({ media: [imgItem("n.png", noisy.length)] }, { "n.png": noisy }, [acct("bluesky")], bskyRoutes(blobs));
  assert(results.bluesky.ok, results.bluesky.error);
  assertEquals(blobs[0].type, "image/jpeg");
  assert(blobs[0].size <= 1_000_000);
});

Deno.test("bluesky: uploaded MP4 -> video service upload, job poll, video embed", async () => {
  const mp4 = fakeMp4(20, { mdatBytes: 5000 });
  const { results, calls } = await run({ media: [vidItem("clip.mp4", mp4.length)] }, { "clip.mp4": mp4 }, [acct("bluesky")], bskyRoutes([]));
  assert(results.bluesky.ok, results.bluesky.error);
  const up = calls.find((c) => c.url.includes("uploadVideo"))!;
  assertEquals((up.body as Uint8Array).byteLength, mp4.length);
  assertEquals(up.headers.get("authorization"), "Bearer svc");
  assertStringIncludes(calls.find((c) => c.url.includes("getServiceAuth"))!.url, "aud=did%3Aweb%3Apds.example.com");
  const rec = bodyOf(calls, "createRecord").record;
  assertEquals(rec.embed.$type, "app.bsky.embed.video");
  assertEquals(rec.embed.aspectRatio, { width: 1080, height: 1920 });
});

// ------------------------------------------------------------ Discord

Deno.test("discord: uploaded images are real multipart attachments with brand name, no mentions", async () => {
  const a = await png(50, 50), b = await jpeg(60, 60);
  let form: FormData | null = null;
  const { results } = await run({ media: [imgItem("a.png", a.length), imgItem("b.jpg", b.length)] }, { "a.png": a, "b.jpg": b }, [acct("discord")],
    [["discord.com/api/webhooks", (c) => { form = c.body as FormData; return json({ id: "m1" }); }]]);
  assert(results.discord.ok, results.discord.error);
  assert(form, "multipart body expected");
  const f = form as unknown as FormData;
  const payload = JSON.parse(f.get("payload_json") as string);
  assertEquals(payload.content, "Hello from the brand");
  assertEquals(payload.username, "Satyr Coffee");
  assertEquals(payload.allowed_mentions, { parse: [] });
  assertEquals(payload.attachments.map((x: any) => x.filename), ["a.png", "b.jpg"]);
  assertEquals((f.get("files[0]") as File).size, a.length);
  assertEquals((f.get("files[1]") as File).type, "image/jpeg");
});

Deno.test("discord: attachments over 10 MB total are split across messages", async () => {
  const mk = async (n: number) => { const x = new Uint8Array(n); x.set(await jpeg(4, 4)); return x; };
  const a = await mk(6_000_000), b = await mk(6_000_000);
  const sends: number[] = [];
  const { results } = await run({ media: [imgItem("a.jpg", a.length), imgItem("b.jpg", b.length)] }, { "a.jpg": a, "b.jpg": b }, [acct("discord")],
    [["discord.com/api/webhooks", (c) => { const f = c.body as FormData; sends.push([...f.keys()].filter((k) => k.startsWith("files")).length); return json({ id: "m" + sends.length }); }]]);
  assert(results.discord.ok);
  assertEquals(sends, [1, 1]);
  assertEquals(results.discord.message_ids, ["m1", "m2"]);
});

Deno.test("discord: oversize video -> clear 'too large' error (no retry storm)", async () => {
  const mp4 = fakeMp4(30, { mdatBytes: 12_000_000 });
  const { results } = await run({ media: [vidItem("big.mp4", mp4.length)] }, { "big.mp4": mp4 }, [acct("discord")],
    [["discord.com/api/webhooks", () => json({ message: "Request entity too large", code: 40005 }, 413)]]);
  assertEquals(results.discord.ok, false);
  assertStringIncludes(results.discord.error!, "discord_file_too_large");
  assertStringIncludes(results.discord.error!, "10 MB");
});

Deno.test("discord: legacy URL fields keep the old JSON embed + link behaviour", async () => {
  let body: any = null;
  const { results } = await run({ image_url: "https://img.test/a.jpg", video_url: "https://vid.test/v.mp4" }, {}, [acct("discord")],
    [["discord.com/api/webhooks", (c) => { body = JSON.parse(c.body); return json({ id: "m1" }); }]]);
  assert(results.discord.ok);
  assertEquals(body.embeds[0].image.url, "https://img.test/a.jpg");
  assertStringIncludes(body.content, "https://vid.test/v.mp4");
});

// ------------------------------------------------------------ Facebook

Deno.test("facebook: single photo by signed URL; multi-photo via unpublished photos + attached_media; video via file_url", async () => {
  const a = await jpeg(50, 50);
  let r = await run({ media: [imgItem("a.jpg", a.length)] }, { "a.jpg": a }, [acct("facebook")], [["/PAGE1/photos", () => json({ id: "ph1", post_id: "PAGE1_99" })]]);
  assertEquals(r.results.facebook.post_id, "PAGE1_99");
  const u = new URL(r.calls[0].url);
  assertStringIncludes(u.searchParams.get("url")!, "https://sb.test/storage/v1/object/sign/post-media/");
  assertEquals(u.searchParams.get("caption"), "Hello from the brand");

  let n = 0;
  r = await run({ media: [imgItem("a.jpg", a.length), imgItem("b.jpg", a.length)] }, { "a.jpg": a, "b.jpg": a }, [acct("facebook")],
    [["/PAGE1/photos", () => json({ id: "ph" + (++n) })], ["/PAGE1/feed", () => json({ id: "PAGE1_100" })]]);
  assertEquals(r.results.facebook.post_id, "PAGE1_100");
  assert(r.calls.filter((c) => c.url.includes("/photos")).every((c) => new URL(c.url).searchParams.get("published") === "false"));
  assertEquals(bodyOf(r.calls, "/feed").attached_media, [{ media_fbid: "ph1" }, { media_fbid: "ph2" }]);

  const mp4 = fakeMp4(15);
  r = await run({ media: [vidItem("v.mp4", mp4.length)] }, { "v.mp4": mp4 }, [acct("facebook")], [["/PAGE1/videos", () => json({ id: "vid1" })]]);
  assertEquals(r.results.facebook.post_id, "vid1");
  assertStringIncludes(bodyOf(r.calls, "/videos").file_url, "/sign/post-media/");
  assertEquals(bodyOf(r.calls, "/videos").description, "Hello from the brand");
});

// ------------------------------------------------------------ Instagram

Deno.test("instagram: PNG uses the browser's JPEG copy; JPEG uses original", async () => {
  const p = await png(100, 100), j = await jpeg(100, 100);
  const r = await run({ media: [imgItem("a.png", p.length, { jpeg_path: P("a-web.jpg"), jpeg_size: j.length })] }, { "a.png": p, "a-web.jpg": j }, [acct("instagram")],
    [["/IG1/media_publish", () => json({ id: "igpost" })], ["/IG1/media", () => json({ id: "cont1" })]]);
  assertEquals(r.results.instagram.post_id, "igpost");
  assertStringIncludes(bodyOf(r.calls, "/IG1/media").image_url, "a-web.jpg");
});

Deno.test("instagram: PNG without a copy is converted to JPEG server-side and stored next to the original", async () => {
  const p = await png(120, 100);
  const r = await run({ media: [imgItem("a.png", p.length, { width: 120, height: 100 })] }, { "a.png": p }, [acct("instagram")],
    [["/IG1/media_publish", () => json({ id: "igpost" })], ["/IG1/media", () => json({ id: "cont1" })]]);
  assert(r.results.instagram.ok, r.results.instagram.error);
  assertEquals(r.svc.uploads[0].path, P("a-ig.jpg"));
  assertEquals(r.svc.uploads[0].opts.contentType, "image/jpeg");
  assertStringIncludes(bodyOf(r.calls, "/IG1/media").image_url, "a-ig.jpg");
});

Deno.test("instagram: 3 images -> carousel; video -> REELS with status polling", async () => {
  const j = await jpeg(100, 100);
  let k = 0;
  let r = await run({ media: [imgItem("a.jpg", j.length), imgItem("b.jpg", j.length), imgItem("c.jpg", j.length)] }, { "a.jpg": j, "b.jpg": j, "c.jpg": j }, [acct("instagram")],
    [["/IG1/media_publish", () => json({ id: "igpost" })], ["/IG1/media", () => json({ id: "c" + (++k) })]]);
  assert(r.results.instagram.ok);
  const media = r.calls.filter((c) => c.url.endsWith("/IG1/media")).map((c) => JSON.parse(c.body));
  assertEquals(media.slice(0, 3).every((b) => b.is_carousel_item === true), true);
  assertEquals(media[3].media_type, "CAROUSEL");
  assertEquals(media[3].children, "c1,c2,c3");
  assertEquals(bodyOf(r.calls, "media_publish").creation_id, "c4");

  const mp4 = fakeMp4(20);
  let polls = 0;
  r = await run({ media: [vidItem("v.mp4", mp4.length)] }, { "v.mp4": mp4 }, [acct("instagram")], [
    ["/IG1/media_publish", () => json({ id: "reel1" })],
    ["/IG1/media", () => json({ id: "rc1" })],
    ["/rc1?fields=status_code", () => json({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" })],
  ]);
  assertEquals(r.results.instagram.post_id, "reel1");
  assertEquals(polls, 3);
  const cont = bodyOf(r.calls, "/IG1/media");
  assertEquals(cont.media_type, "REELS");
  assertStringIncludes(cont.video_url, "/sign/post-media/");
});

Deno.test("instagram: video processing ERROR is reported, nothing published", async () => {
  const mp4 = fakeMp4(20);
  const r = await run({ media: [vidItem("v.mp4", mp4.length)] }, { "v.mp4": mp4 }, [acct("instagram")], [
    ["/IG1/media_publish", () => json({ id: "never" })],
    ["/IG1/media", () => json({ id: "rc1" })],
    ["/rc1?fields", () => json({ status_code: "ERROR", status: "Error: unsupported codec" })],
  ]);
  assertEquals(r.results.instagram.ok, false);
  assertStringIncludes(r.results.instagram.error!, "instagram_video_processing_failed");
  assertEquals(r.calls.some((c) => c.url.includes("media_publish")), false);
  assertEquals(r.results.instagram.error!.includes("fast start"), false);
});

Deno.test("instagram: processing ERROR on a moov-at-end MP4 tells the user to re-export with fast start", async () => {
  const mp4 = fakeMp4(20, { moovFirst: false });
  const r = await run({ media: [vidItem("v.mp4", mp4.length)] }, { "v.mp4": mp4 }, [acct("instagram")], [
    ["/IG1/media", () => json({ id: "rc1" })],
    ["/rc1?fields", () => json({ status_code: "ERROR", status: "Error" })],
  ]);
  assertStringIncludes(r.results.instagram.error!, "fast start");
});

// ------------------------------------------------------------ TikTok

const ttRoutes = (extra: Parameters<typeof mockFetch>[0] = []): Parameters<typeof mockFetch>[0] => [
  ["creator_info/query", () => json({ data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], creator_nickname: "brand" }, error: { code: "ok" } })],
  ["status/fetch", () => json({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } })],
  ...extra,
];

Deno.test("tiktok: uploaded MP4 goes up with FILE_UPLOAD (single chunk) from storage bytes", async () => {
  const mp4 = fakeMp4(20, { mdatBytes: 3000 });
  const r = await run({ media: [vidItem("v.mp4", mp4.length)] }, { "v.mp4": mp4 }, [acct("tiktok")], ttRoutes([
    ["video/init", () => json({ data: { publish_id: "p1", upload_url: "https://upload.tiktok.test/u" }, error: { code: "ok" } })],
    ["upload.tiktok.test", () => new Response(null, { status: 201 })],
  ]));
  assert(r.results.tiktok.ok, r.results.tiktok.error);
  const init = bodyOf(r.calls, "video/init");
  assertEquals(init.source_info, { source: "FILE_UPLOAD", video_size: mp4.length, chunk_size: mp4.length, total_chunk_count: 1 });
  const put = r.calls.find((c) => c.url.includes("upload.tiktok.test"))!;
  assertEquals(put.headers.get("content-range"), `bytes 0-${mp4.length - 1}/${mp4.length}`);
});

Deno.test("tiktok: 2 uploaded images -> both staged to tiktok-media and sent as one photo post", async () => {
  const a = await png(1200, 800), b = await jpeg(500, 500);
  const r = await run({ media: [imgItem("a.png", a.length), imgItem("b.jpg", b.length)] }, { "a.png": a, "b.jpg": b }, [acct("tiktok")], ttRoutes([
    ["content/init", () => json({ data: { publish_id: "pp1" }, error: { code: "ok" } })],
  ]));
  assert(r.results.tiktok.ok, r.results.tiktok.error);
  const staged = r.svc.uploads.filter((u) => u.bucket === "tiktok-media");
  assertEquals(staged.length, 2);
  const init = bodyOf(r.calls, "content/init");
  assertEquals(init.media_type, "PHOTO");
  assertEquals(init.source_info.photo_images.length, 2);
  assert(init.source_info.photo_images.every((u: string) => u.startsWith("https://brandparent.app/tt-media/d1/")));
});

// ------------------------------------------------------------ skips + summary

Deno.test("video post: LinkedIn and Pinterest are skipped with a clear message; others still post", async () => {
  const mp4 = fakeMp4(20);
  const r = await run({ media: [vidItem("v.mp4", mp4.length)] }, { "v.mp4": mp4 }, [acct("linkedin"), acct("pinterest"), acct("facebook")],
    [["/PAGE1/videos", () => json({ id: "vid1" })]]);
  assertEquals(r.results.linkedin.skipped, true);
  assertStringIncludes(r.results.linkedin.error!, "uncheck LinkedIn");
  assertEquals(r.results.pinterest.skipped, true);
  assert(r.results.facebook.ok);
  assertEquals(r.calls.some((c) => c.url.includes("linkedin") || c.url.includes("pinterest")), false);
  const s = summarize(r.results);
  assertEquals(s.anySucceeded, true);
  assertEquals(s.onlySkips, false);
  assertEquals(s.firstPostId, "vid1");
});

Deno.test("summary: only skips -> onlySkips (cron hands the post back as a draft)", async () => {
  const j = await jpeg(100, 100);
  const r = await run({ media: [imgItem("tall.jpg", j.length, { width: 1080, height: 1920 })] }, { "tall.jpg": j }, [acct("instagram")], []);
  assertEquals(r.results.instagram.skipped, true);
  assertStringIncludes(r.results.instagram.error!, "4:5");
  assertEquals(summarize(r.results).onlySkips, true);
  assertEquals(r.calls.length, 0);
});

Deno.test("toJpegUnder shrinks noisy images under a byte cap", async () => {
  const noisy = await png(1200, 1200, true);
  const out = await toJpegUnder(noisy, 300_000);
  assert(out.byteLength <= 300_000);
  assertEquals(out[0], 0xff);
});
