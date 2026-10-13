// Tumblr connect + publish with mocked Tumblr API and service client.
// Run: deno test --allow-read --allow-env --allow-net=deno.land supabase/functions/_shared/
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { publishToAccounts, summarize } from "./publish.ts";
import { DraftMedia, planMedia } from "./media.ts";
import { fetchTumblrBlogs, handleTumblrCallback, textBlocks, tumblrAuthorizeUrl, tumblrDeps } from "./tumblr.ts";
import "../../../js/media-rules.js";
import { CID, fakeMp4, jpeg, json, mockFetch, mockSvc, P, UID } from "./test_helpers.ts";

const ENV: Record<string, string> = { TUMBLR_CLIENT_ID: "ck", TUMBLR_CLIENT_SECRET: "cs" };
tumblrDeps.env = (k) => ENV[k];

const BLOGS = [
  { uuid: "t:side", name: "satyr-side", title: "Side Blog", url: "https://satyr-side.tumblr.com/", primary: false },
  { uuid: "t:main", name: "greensatyr", title: "GreenSatyr", url: "https://greensatyr.tumblr.com/", primary: true },
];
const acct = (extra: Record<string, unknown> = {}) => ({
  id: "acct-tumblr", platform: "tumblr", user_id: UID, cubicle_id: CID,
  external_account_id: "t:main", external_account_name: "GreenSatyr (greensatyr)",
  access_token: "tok", refresh_token: "rt1", token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  account_meta: { username: "satyr", blogs: BLOGS }, ...extra,
});
const imgItem = (f: string, size: number, extra: Record<string, unknown> = {}) => ({ path: P(f), kind: "image", mime: "image/jpeg", size, name: f, width: 1080, height: 1350, ...extra });
const vidItem = (f: string, size: number) => ({ path: P(f), kind: "video", mime: "video/mp4", size, name: f, duration: 2, width: 1080, height: 1920 });

async function run(draftExtra: Record<string, unknown>, files: Record<string, Uint8Array>, accounts: any[], routes: Parameters<typeof mockFetch>[0]) {
  const svc = mockSvc(Object.fromEntries(Object.entries(files).map(([k, v]) => [`post-media/${P(k)}`, v])));
  const draft = { id: "d1", user_id: UID, cubicle_id: CID, content: "Fresh roast today.\n\nCome by the shop!", media: [], ...draftExtra };
  const m = mockFetch(routes);
  try {
    const media = new DraftMedia(svc, draft);
    await media.prepare();
    return { results: await publishToAccounts(svc, draft, accounts, media), calls: m.calls, svc };
  } finally { m.restore(); }
}
const created = (id = "7301") => json({ meta: { status: 201, msg: "Created" }, response: { id, state: "published" } }, 201);

Deno.test("tumblr: authorize URL carries scopes, state and the callback", () => {
  const u = new URL(tumblrAuthorizeUrl("ck", CID));
  assertEquals(u.origin + u.pathname, "https://www.tumblr.com/oauth2/authorize");
  assertEquals(u.searchParams.get("scope"), "basic write offline_access");
  assertEquals(u.searchParams.get("state"), CID);
  assertEquals(u.searchParams.get("redirect_uri"), "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/tumblr-oauth-callback");
});

Deno.test("tumblr: text-only post becomes paragraph text blocks and returns a post URL", async () => {
  const { results, calls } = await run({}, {}, [acct()], [["/blog/", () => created()]]);
  assert(results.tumblr.ok, results.tumblr.error);
  assertEquals(results.tumblr.post_url, "https://www.tumblr.com/greensatyr/7301");
  const c = calls.find((x) => x.url.includes("/posts"))!;
  assertEquals(c.url, "https://api.tumblr.com/v2/blog/t%3Amain/posts");
  assertEquals(c.headers.get("authorization"), "Bearer tok");
  const body = JSON.parse(c.body);
  assertEquals(body.content, [{ type: "text", text: "Fresh roast today." }, { type: "text", text: "Come by the shop!" }]);
  assertEquals(summarize(results).firstPostId, "7301");
});

Deno.test("tumblr: images go in by signed post-media URL with size and alt text", async () => {
  const a = await jpeg(16, 16), b = await jpeg(16, 16);
  const { results, calls } = await run(
    { media: [imgItem("a.jpg", a.length, { alt: "Beans" }), imgItem("b.jpg", b.length)] },
    { "a.jpg": a, "b.jpg": b }, [acct()], [["/blog/", () => created()]]);
  assert(results.tumblr.ok, results.tumblr.error);
  const body = JSON.parse(calls.find((x) => x.url.includes("/posts"))!.body);
  assertEquals(body.content.length, 4);
  assertEquals(body.content[0], { type: "image", media: [{ url: `https://sb.test/storage/v1/object/sign/post-media/${P("a.jpg")}?token=T`, type: "image/jpeg", width: 1080, height: 1350 }], alt_text: "Beans" });
  assertEquals(body.content[1].type, "image");
  assertEquals(body.content[2].type, "text");
});

Deno.test("tumblr: video is uploaded as multipart with a matching identifier", async () => {
  const v = fakeMp4(2);
  const { results, calls } = await run({ media: [vidItem("v.mp4", v.length)] }, { "v.mp4": v }, [acct()], [["/blog/", () => created()]]);
  assert(results.tumblr.ok, results.tumblr.error);
  assertStringIncludes(results.tumblr.note!, "processing the video");
  const fd = calls.find((x) => x.url.includes("/posts"))!.body as FormData;
  assert(fd instanceof FormData);
  const j = JSON.parse(await (fd.get("json") as Blob).text());
  assertEquals(j.content[0], { type: "video", media: { type: "video/mp4", identifier: "video0", width: 1080, height: 1920 } });
  const file = fd.get("video0") as File;
  assertEquals(file.size, v.length);
  assertEquals(file.type, "video/mp4");
});

Deno.test("tumblr: expired token is refreshed first and the rotated refresh token is saved", async () => {
  const { results, calls, svc } = await run({}, {}, [acct({ token_expires_at: new Date(Date.now() - 1000).toISOString() })], [
    ["/oauth2/token", () => json({ access_token: "tok2", refresh_token: "rt2", expires_in: 2520 })],
    ["/blog/", () => created()],
  ]);
  assert(results.tumblr.ok, results.tumblr.error);
  const tc = calls.find((x) => x.url.includes("/oauth2/token"))!;
  const form = new URLSearchParams(String(tc.body));
  assertEquals(form.get("grant_type"), "refresh_token");
  assertEquals(form.get("refresh_token"), "rt1");
  assertEquals(form.get("client_id"), "ck");
  assertEquals(calls.find((x) => x.url.includes("/posts"))!.headers.get("authorization"), "Bearer tok2");
  assertEquals(svc.updates[0].access_token, "tok2");
  assertEquals(svc.updates[0].refresh_token, "rt2");
});

Deno.test("tumblr: a 401 triggers one refresh + retry", async () => {
  let n = 0;
  const { results, calls } = await run({}, {}, [acct()], [
    ["/oauth2/token", () => json({ access_token: "tok2", refresh_token: "rt2", expires_in: 2520 })],
    ["/blog/", () => (++n === 1 ? json({ meta: { status: 401, msg: "Unauthorized" } }, 401) : created("99"))],
  ]);
  assert(results.tumblr.ok, results.tumblr.error);
  assertEquals(results.tumblr.post_id, "99");
  assertEquals(calls.filter((x) => x.url.includes("/posts")).length, 2);
});

Deno.test("tumblr: failed refresh and API errors are clear", async () => {
  const r1 = await run({}, {}, [acct({ token_expires_at: new Date(Date.now() - 1000).toISOString() })], [
    ["/oauth2/token", () => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400)],
  ]);
  assertStringIncludes(r1.results.tumblr.error!, "tumblr_reconnect_needed");
  assertStringIncludes(r1.results.tumblr.error!, "Refresh token revoked");
  const r2 = await run({}, {}, [acct()], [["/blog/", () => json({ meta: { status: 400, msg: "Bad Request" }, errors: [{ title: "Bad Request", code: 8001, detail: "Posting failed. Try again." }] }, 400)]]);
  assertStringIncludes(r2.results.tumblr.error!, "tumblr_post_error: Posting failed. Try again. (code 8001)");
  const r3 = await run({}, {}, [acct()], [["/blog/", () => json({ meta: { status: 429, msg: "Limit Exceeded" } }, 429)]]);
  assertStringIncludes(r3.results.tumblr.error!, "tumblr_rate_limited");
  const r4 = await run({}, {}, [acct({ external_account_id: "" })], []);
  assertStringIncludes(r4.results.tumblr.error!, "tumblr_no_blog");
});

Deno.test("tumblr: media plan and text blocks", () => {
  const img = { kind: "image", mime: "image/jpeg", source: "upload", name: "a" } as any;
  const vid = { kind: "video", mime: "video/mp4", source: "upload", name: "v" } as any;
  assertEquals(planMedia("tumblr", { mode: "none", images: [], video: null }).use, "none");
  assertEquals(planMedia("tumblr", { mode: "upload", images: [img, img], video: null }).use, "images");
  assertEquals(planMedia("tumblr", { mode: "upload", images: [], video: vid }).use, "video");
  assertEquals(textBlocks("  \n\n "), []);
  assertEquals(textBlocks("a\nb"), [{ type: "text", text: "a\nb" }]);
});

// ------------------------------------------------------------ connect callback

function cbSvc() {
  const upserts: any[] = [];
  return {
    upserts,
    from: (_t: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { user_id: UID } }) }) }),
      upsert: async (row: any, opts: any) => { upserts.push({ row, opts }); return { error: null }; },
    }),
  };
}
const cbRoutes = (blogs: unknown[]): Parameters<typeof mockFetch>[0] => [
  ["/oauth2/token", () => json({ access_token: "at", refresh_token: "rt", expires_in: 2520, token_type: "bearer" })],
  ["/user/info", (c) => c.headers.get("authorization") === "Bearer at" ? json({ meta: { status: 200 }, response: { user: { name: "satyr", blogs } } }) : json({}, 401)],
];

Deno.test("tumblr callback: saves tokens + blogs, defaults to the primary blog, asks to pick when >1", async () => {
  const svc = cbSvc();
  const m = mockFetch(cbRoutes(BLOGS));
  try {
    const to = await handleTumblrCallback(`https://x/fn?code=abc&state=${CID}`, svc);
    assertEquals(to, `https://brandparent.app/app.html?pick_tumblr=${CID}`);
    const form = new URLSearchParams(String(m.calls[0].body));
    assertEquals(form.get("grant_type"), "authorization_code");
    assertEquals(form.get("code"), "abc");
    assertEquals(form.get("client_secret"), "cs");
    assertEquals(form.get("redirect_uri"), "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/tumblr-oauth-callback");
  } finally { m.restore(); }
  const { row, opts } = svc.upserts[0];
  assertEquals(opts, { onConflict: "cubicle_id,platform" });
  assertEquals(row.platform, "tumblr");
  assertEquals(row.external_account_id, "t:main");
  assertEquals(row.external_account_name, "GreenSatyr (greensatyr)");
  assertEquals(row.access_token, "at");
  assertEquals(row.refresh_token, "rt");
  assertEquals(row.account_meta.blogs.map((b: any) => b.uuid), ["t:main", "t:side"]);
  assert(Date.parse(row.token_expires_at) > Date.now());
});

Deno.test("tumblr callback: single blog -> connected; errors redirect with a reason", async () => {
  let svc = cbSvc();
  let m = mockFetch(cbRoutes([BLOGS[1]]));
  try { assertEquals(await handleTumblrCallback(`https://x/fn?code=abc&state=${CID}`, svc), "https://brandparent.app/app.html?connected=Tumblr"); }
  finally { m.restore(); }
  assertEquals(await handleTumblrCallback(`https://x/fn?error=access_denied&state=${CID}`, svc), "https://brandparent.app/app.html?connect_error=" + encodeURIComponent("tumblr: you cancelled the Tumblr login"));
  svc = cbSvc();
  m = mockFetch(cbRoutes([]));
  try { assertStringIncludes(decodeURIComponent(await handleTumblrCallback(`https://x/fn?code=abc&state=${CID}`, svc)), "tumblr_no_blogs"); }
  finally { m.restore(); }
  assertEquals(svc.upserts.length, 0);
  delete ENV.TUMBLR_CLIENT_SECRET;
  try { assertStringIncludes(decodeURIComponent(await handleTumblrCallback(`https://x/fn?code=abc&state=${CID}`, cbSvc())), "tumblr_not_configured"); }
  finally { ENV.TUMBLR_CLIENT_SECRET = "cs"; }
});

Deno.test("tumblr: user/info parsing sorts primary first", async () => {
  const m = mockFetch(cbRoutes(BLOGS));
  try { assertEquals((await fetchTumblrBlogs("at")).blogs[0].name, "greensatyr"); } finally { m.restore(); }
});

Deno.test("tumblr: client platformHints know Tumblr", () => {
  const RULES = (globalThis as any).BPMediaRules;
  assertEquals(RULES.platformHints([{ kind: "video", size: 1, duration: 5 }], ["tumblr"])[0].level, "ok");
  assertStringIncludes(RULES.platformHints([{ kind: "image", size: 1 }, { kind: "image", size: 1 }], ["tumblr"])[0].text, "Tumblr: 2-photo post.");
});
