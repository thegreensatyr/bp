// Run: deno test --allow-read supabase/functions/_shared/
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { checkBytes, DraftMedia, imageDims, LIMITS, MediaError, mp4Info, planMedia, sniffMime, validateStoredMedia } from "./media.ts";
import { CID, fakeMp4, jpeg, mockSvc, OTHER, P, png, UID } from "./test_helpers.ts";
import "../../../js/media-rules.js";

// deno-lint-ignore no-explicit-any
const RULES = (globalThis as any).BPMediaRules;
const td = (f: string) => Deno.readFileSync(new URL(`./testdata/${f}`, import.meta.url));

// ------------------------------------------------------------ validateStoredMedia

const img = (f: string, extra: Record<string, unknown> = {}) => ({ path: P(f), kind: "image", mime: f.endsWith(".png") ? "image/png" : "image/jpeg", size: 1000, ...extra });
const vid = (f: string, extra: Record<string, unknown> = {}) => ({ path: P(f), kind: "video", mime: "video/mp4", size: 1000, ...extra });

Deno.test("validate: accepts up to 4 images or 1 video in the owner's folder", () => {
  assertEquals(validateStoredMedia(null, UID, CID), []);
  assertEquals(validateStoredMedia([], UID, CID), []);
  assertEquals(validateStoredMedia([img("a.png"), img("b.jpg"), img("c.jpeg"), img("d.jpg")], UID, CID).length, 4);
  const v = validateStoredMedia([vid("clip.mp4", { duration: 12.5, width: 1080, height: 1920 })], UID, CID);
  assertEquals(v[0].kind, "video");
  assertEquals(v[0].duration, 12.5);
  const withCopy = validateStoredMedia([img("big.png", { jpeg_path: P("big-web.jpg"), jpeg_size: 900000 })], UID, CID);
  assertEquals(withCopy[0].jpeg_path, P("big-web.jpg"));
});

Deno.test("validate: rejects foreign / traversal / odd paths", () => {
  const bad = [
    [{ ...img("x.jpg"), path: OTHER }],
    [{ ...img("x.jpg"), path: `${UID}/b2222222-2222-4222-8222-222222222222/x.jpg` }],
    [{ ...img("x.jpg"), path: `${UID}/${CID}/../x.jpg` }],
    [{ ...img("x.jpg"), path: `${UID}/${CID}/sub/x.jpg` }],
    [{ ...img("x.jpg"), path: `/${UID}/${CID}/x.jpg` }],
    [img("x.jpg", { jpeg_path: OTHER })],
    [img("x.jpg", { jpeg_path: P("x.png") })],
  ];
  for (const m of bad) {
    const e = assertThrows(() => validateStoredMedia(m, UID, CID), MediaError) as MediaError;
    assertEquals(e.code, "media_forbidden_path");
    assert(e.permanent);
  }
});

Deno.test("validate: rejects wrong types, sizes, counts and mixes", () => {
  const cases: Array<[unknown, string]> = [
    [{ path: P("a.jpg") }, "media_invalid"],
    [[{ ...img("a.gif"), mime: "image/gif" }], "media_forbidden_path"],
    [[img("a.jpg", { mime: "image/png" })], "media_unsupported_type"],
    [[img("a.mp4", { kind: "image", mime: "video/mp4" })], "media_invalid"],
    [[img("a.jpg", { size: LIMITS.imageMaxBytes + 1 })], "media_too_large"],
    [[vid("a.mp4", { size: LIMITS.videoMaxBytes + 1 })], "media_too_large"],
    [[img("1.jpg"), img("2.jpg"), img("3.jpg"), img("4.jpg"), img("5.jpg")], "media_too_many"],
    [[vid("1.mp4"), vid("2.mp4")], "media_too_many"],
    [[img("1.jpg"), vid("2.mp4")], "media_mixed"],
  ];
  for (const [m, code] of cases) {
    const e = assertThrows(() => validateStoredMedia(m, UID, CID), MediaError) as MediaError;
    assertEquals(e.code, code, JSON.stringify(m));
  }
});

// ------------------------------------------------------------ sniffing / parsing

Deno.test("sniff + dims: real PNG and JPEG bytes", async () => {
  const p = await png(640, 480), j = await jpeg(300, 500);
  assertEquals(sniffMime(p), "image/png");
  assertEquals(sniffMime(j), "image/jpeg");
  assertEquals(imageDims(p), { width: 640, height: 480 });
  assertEquals(imageDims(j), { width: 300, height: 500 });
  assertEquals(sniffMime(new TextEncoder().encode("GIF89a........")), null);
  assertEquals(sniffMime(fakeMp4(5)), "video/mp4");
});

Deno.test("mp4Info: synthetic boxes (v0, v1, 64-bit mdat, moov at end)", () => {
  assertEquals(mp4Info(fakeMp4(30)).duration, 30);
  assertEquals(mp4Info(fakeMp4(89.5, { version: 1, timescale: 90000 })).duration, 89.5);
  assertEquals(mp4Info(fakeMp4(12, { largeMdat: true, moovFirst: false })).duration, 12);
  assertEquals(mp4Info(fakeMp4(12)).moovFirst, true);
  assertEquals(mp4Info(fakeMp4(12, { moovFirst: false })).moovFirst, false);
  assertEquals(mp4Info(new Uint8Array(32)).duration, null);
});

Deno.test("mp4Info: real ffmpeg files match ffprobe", () => {
  assertEquals(mp4Info(td("clip-2s.mp4")).duration, 2);
  assertEquals(mp4Info(td("clip-2s.mp4")).moovFirst, false);       // ffmpeg default: moov at the end
  assertEquals(mp4Info(td("clip-2s-faststart.mp4")).moovFirst, true);
  assertEquals(Math.round(mp4Info(td("clip-95s.mp4")).duration!), 95);
  const site = Deno.readFileSync(new URL("../../../brandparent-video.mp4", import.meta.url)); // ffprobe: 59.4 s
  assertEquals(Math.round(mp4Info(site).duration! * 10) / 10, 59.4);
});

Deno.test("checkBytes: type mismatch, too long, too short, too big", async () => {
  const j = await jpeg(10, 10);
  assertThrows(() => checkBytes({ kind: "image", mime: "image/png", name: "fake.png" }, j), MediaError, "isn't really a PNG");
  assertThrows(() => checkBytes({ kind: "video", mime: "video/mp4" }, td("clip-95s.mp4")), MediaError, "95s");
  assertThrows(() => checkBytes({ kind: "video", mime: "video/mp4" }, fakeMp4(0.4)), MediaError, "shorter");
  assertThrows(() => checkBytes({ kind: "video", mime: "video/mp4" }, j), MediaError, "isn't really a MP4");
  const big = new Uint8Array(LIMITS.imageMaxBytes + 10); big.set(j.subarray(0, 3));
  assertThrows(() => checkBytes({ kind: "image", mime: "image/jpeg" }, big), MediaError, "8 MB");
  assertEquals(checkBytes({ kind: "video", mime: "video/mp4" }, td("clip-2s.mp4")).duration, 2);
});

// ------------------------------------------------------------ DraftMedia

Deno.test("DraftMedia: uploads win over URL fields; prepare() checks real bytes", async () => {
  const p = await png(800, 1000);
  const svc = mockSvc({ [`post-media/${P("a.png")}`]: p });
  const m = new DraftMedia(svc, { user_id: UID, cubicle_id: CID, image_url: "https://x.test/legacy.jpg", media: [img("a.png", { size: p.length })] });
  assertEquals(m.set.mode, "upload");
  await m.prepare();
  assertEquals(m.set.images[0].width, 800);
  const url = await m.url(m.set.images[0]);
  assert(url.startsWith("https://sb.test/storage/v1/object/sign/post-media/"));
  assertEquals(svc.signed[0].ttl, LIMITS.signedUrlTtlSeconds);
});

Deno.test("DraftMedia: legacy URL mode when nothing uploaded", () => {
  const m = new DraftMedia(mockSvc({}), { user_id: UID, cubicle_id: CID, image_url: " https://x.test/a.jpg ", video_url: "https://x.test/v.mp4", media: [] });
  assertEquals(m.set.mode, "url");
  assertEquals(m.set.images[0].url, "https://x.test/a.jpg");
  assertEquals(m.set.video?.url, "https://x.test/v.mp4");
  assertEquals(new DraftMedia(mockSvc({}), { user_id: UID, cubicle_id: CID }).set.mode, "none");
});

Deno.test("DraftMedia: missing file is a permanent error; forged bytes rejected; forbidden path throws in constructor", async () => {
  const m1 = new DraftMedia(mockSvc({}), { user_id: UID, cubicle_id: CID, media: [img("gone.jpg")] });
  const e1 = await assertRejects(() => m1.prepare(), MediaError) as MediaError;
  assertEquals(e1.code, "media_missing"); assert(e1.permanent);
  const m2 = new DraftMedia(mockSvc({ [`post-media/${P("x.mp4")}`]: await jpeg(4, 4) }), { user_id: UID, cubicle_id: CID, media: [vid("x.mp4")] });
  await assertRejects(() => m2.prepare(), MediaError, "isn't really a MP4");
  assertThrows(() => new DraftMedia(mockSvc({}), { user_id: UID, cubicle_id: CID, media: [{ ...img("x.jpg"), path: OTHER }] }), MediaError);
});

// ------------------------------------------------------------ planMedia

const R = (o: Record<string, unknown>) => ({ source: "upload", name: "f", alt: "", ...o }) as any;
const upImgs = (n: number, extra: Record<string, unknown> = {}) => ({ mode: "upload" as const, images: Array.from({ length: n }, (_, i) => R({ kind: "image", mime: "image/png", name: `i${i}.png`, width: 1080, height: 1080, ...extra })), video: null });
const upVid = (extra: Record<string, unknown> = {}) => ({ mode: "upload" as const, images: [], video: R({ kind: "video", mime: "video/mp4", duration: 20, ...extra }) });
const none = { mode: "none" as const, images: [], video: null };

Deno.test("plan: per-platform choices for images", () => {
  for (const p of ["bluesky", "facebook", "instagram", "tiktok", "discord"]) assertEquals(planMedia(p, upImgs(3)).use, "images", p);
  assertEquals((planMedia("linkedin", upImgs(3)) as any).images.length, 1);
  assertEquals((planMedia("pinterest", upImgs(2)) as any).images.length, 1);
});

Deno.test("plan: per-platform choices for video, with graceful skips", () => {
  for (const p of ["bluesky", "facebook", "instagram", "tiktok", "discord"]) assertEquals(planMedia(p, upVid()).use, "video", p);
  for (const p of ["linkedin", "pinterest"]) {
    const pl = planMedia(p, upVid());
    assertEquals(pl.use, "skip", p);
    assert((pl as any).reason.includes("video"), p);
  }
  assertEquals(planMedia("instagram", upVid({ duration: 2 })).use, "skip");
});

Deno.test("plan: Instagram aspect ratio and media-required platforms", () => {
  assertEquals(planMedia("instagram", upImgs(1, { width: 1080, height: 1350 })).use, "images"); // 4:5
  assertEquals(planMedia("instagram", upImgs(1, { width: 1910, height: 1000 })).use, "images"); // 1.91:1
  assertEquals(planMedia("instagram", upImgs(1, { width: 1080, height: 1920 })).use, "skip");   // 9:16 photo
  assertEquals(planMedia("instagram", upImgs(1, { width: 3000, height: 1000 })).use, "skip");
  assertEquals(planMedia("instagram", none).use, "skip");
  assertEquals(planMedia("tiktok", none).use, "skip");
  assertEquals(planMedia("pinterest", none).use, "skip");
  for (const p of ["bluesky", "facebook", "discord", "linkedin"]) assertEquals(planMedia(p, none).use, "none", p);
});

Deno.test("plan: legacy URL mode keeps old behaviour", () => {
  const set = { mode: "url" as const, images: [R({ kind: "image", source: "url", url: "https://x/a.jpg" })], video: R({ kind: "video", source: "url", url: "https://x/v.mp4" }) };
  assertEquals(planMedia("facebook", set).use, "images");
  assertEquals(planMedia("instagram", set).use, "images");
  assertEquals(planMedia("bluesky", set).use, "video");
  assertEquals(planMedia("tiktok", set).use, "video");
  assertEquals(planMedia("discord", set).use, "images+video");
  const vidOnly = { mode: "url" as const, images: [], video: set.video };
  assertEquals(planMedia("facebook", vidOnly).use, "none"); // unchanged: FB never used video_url
});

// ------------------------------------------------------------ browser rules (js/media-rules.js)

Deno.test("client/server limits are identical", () => {
  const c = RULES.RULES;
  assertEquals(c.maxImages, LIMITS.maxImages);
  assertEquals(c.maxVideos, LIMITS.maxVideos);
  assertEquals(c.imageMaxBytes, LIMITS.imageMaxBytes);
  assertEquals(c.videoMaxBytes, LIMITS.videoMaxBytes);
  assertEquals(c.videoMaxSeconds, LIMITS.videoMaxSeconds);
  assertEquals(c.videoMinSeconds, LIMITS.videoMinSeconds);
  assertEquals(c.blueskyImageMaxBytes, LIMITS.blueskyImageMaxBytes);
  assertEquals(c.discordUploadMaxBytes, LIMITS.discordUploadMaxBytes);
  assertEquals(c.instagramVideoMinSeconds, LIMITS.instagramVideoMinSeconds);
  assertEquals(c.instagramAspectMin, LIMITS.instagramAspectMin);
  assertEquals(c.instagramAspectMax, LIMITS.instagramAspectMax);
  assert(c.jpegCopyTargetBytes < LIMITS.blueskyImageMaxBytes);
  // and match the migration's bucket + check constraint
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261006000004_post_media_uploads.sql", import.meta.url));
  assert(sql.includes(`'post-media', 'post-media', false, ${LIMITS.videoMaxBytes}`));
  assert(sql.includes(`> ${LIMITS.imageMaxBytes} then`));
  assert(sql.includes(`> ${LIMITS.videoMaxBytes} then`));
});

Deno.test("client typeOf / sniff / mp4Duration", async () => {
  assertEquals(RULES.typeOf("a.PNG", "image/png").mime, "image/png");
  assertEquals(RULES.typeOf("a.jpeg", "").kind, "image");
  assertEquals(RULES.typeOf("clip.mp4", "video/mp4").kind, "video");
  assertEquals(RULES.typeOf("a.heic", "image/heic"), null);
  assertEquals(RULES.typeOf("a.jpg", "image/heic"), null);      // renamed HEIC
  assertEquals(RULES.typeOf("clip.mov", "video/quicktime"), null);
  assertEquals(RULES.typeOf("a.gif", "image/gif"), null);
  assertEquals(RULES.sniff(await png(2, 2)), "image/png");
  assertEquals(RULES.sniff(await jpeg(2, 2)), "image/jpeg");
  assertEquals(RULES.mp4Duration(td("clip-2s.mp4")), 2);
  assertEquals(RULES.mp4Duration(fakeMp4(45, { version: 1 })), 45);
});

Deno.test("client checkAdd: counts, mixing, sizes", () => {
  const f = (name: string, size = 1000, type = "") => ({ name, size, type });
  let r = RULES.checkAdd([], [f("1.jpg"), f("2.png"), f("3.jpg"), f("4.jpg"), f("5.jpg")]);
  assertEquals(r.accepted.length, 4); assertEquals(r.errors.length, 1);
  r = RULES.checkAdd([{ kind: "image" }], [f("v.mp4")]);
  assertEquals(r.accepted.length, 0); assert(r.errors[0].includes("not both"));
  r = RULES.checkAdd([{ kind: "video" }], [f("a.jpg")]);
  assertEquals(r.accepted.length, 0);
  r = RULES.checkAdd([], [f("v.mp4"), f("w.mp4")]);
  assertEquals(r.accepted.length, 1);
  r = RULES.checkAdd([], [f("v.mp4", LIMITS.videoMaxBytes + 1)]);
  assert(r.errors[0].includes("50 MB"));
  r = RULES.checkAdd([], [f("big.jpg", 15_000_000)]);   // will be shrunk in the browser, so accepted
  assertEquals(r.accepted.length, 1);
  r = RULES.checkAdd([], [f("huge.jpg", 50_000_000), f("empty.png", 0), f("x.gif")]);
  assertEquals(r.accepted.length, 0); assertEquals(r.errors.length, 3);
  assertEquals(RULES.checkVideoDuration(91.2) !== null, true);
  assertEquals(RULES.checkVideoDuration(90.3), null);
  assertEquals(RULES.checkVideoDuration(undefined), null);
});

Deno.test("client toDraftMedia output passes the server validator", () => {
  const items = [
    { status: "done", path: P("a.png"), kind: "image", mime: "image/png", size: 2_000_000, name: "Cat.png", width: 1200.4, height: 900, jpegPath: P("a-web.jpg"), jpegSize: 900_000 },
    { status: "uploading", path: null, kind: "image", mime: "image/jpeg", size: 1 },
  ];
  const media = RULES.toDraftMedia(items);
  assertEquals(media.length, 1);
  assertEquals(media[0].width, 1200);
  assertEquals(validateStoredMedia(media, UID, CID)[0].jpeg_path, P("a-web.jpg"));
});

Deno.test("client platformHints mirror the server plan", () => {
  const vid = [{ kind: "video", size: 23_000_000, duration: 20 }];
  const hints = RULES.platformHints(vid, ["bluesky", "instagram", "discord", "linkedin", "pinterest"]);
  const by = (p: string) => hints.find((h: any) => h.platform === p);
  assertEquals(by("bluesky").level, "ok");
  assertEquals(by("instagram").level, "ok");
  assertEquals(by("discord").level, "warn");
  assertEquals(by("linkedin").level, "skip");
  assertEquals(by("pinterest").level, "skip");
  const tall = RULES.platformHints([{ kind: "image", mime: "image/jpeg", size: 1, width: 1080, height: 1920, name: "story.jpg" }], ["instagram"]);
  assertEquals(tall[0].level, "skip");
  assertEquals(planMedia("instagram", upImgs(1, { width: 1080, height: 1920 })).use, "skip");
  const pngs = RULES.platformHints([{ kind: "image", mime: "image/png", size: 2_000_000, width: 1000, height: 1000 }], ["instagram", "bluesky"]);
  assertEquals(pngs.map((h: any) => h.level), ["info", "info"]);
  assertEquals(RULES.platformHints([], ["bluesky"]).length, 0);
});
