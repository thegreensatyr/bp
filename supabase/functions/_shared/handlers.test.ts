// End-to-end wiring of the two real edge-function handlers (publish-post and
// cron-publish-scheduled) with the real supabase-js client, against a mocked
// Supabase HTTP API (auth, PostgREST, Storage) and mocked platform APIs.
// Run: deno test --allow-read --allow-env --allow-net=deno.land supabase/functions/_shared/
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { deps } from "./publish.ts";
import { CID, fakeMp4, jpeg, json, P, UID } from "./test_helpers.ts";

deps.sleep = async () => {};
const SB = "https://sbtest.supabase.co";
Deno.env.set("SUPABASE_URL", SB);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("CRON_SECRET", "cron-secret-test");

type Handler = (req: Request) => Promise<Response>;
const handlers: Handler[] = [];
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: Handler) => { handlers.push(h); return { finished: Promise.resolve(), shutdown() {} }; };
await import("../publish-post/index.ts");
await import("../cron-publish-scheduled/index.ts");
const [publishPost, cronPublish] = handlers;

const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"t".repeat(60)}`;

function fakeSupabase(state: { drafts: any[]; accounts: any[]; files: Record<string, Uint8Array> }) {
  const patches: Array<{ id: string; body: any }> = [];
  const discordForms: FormData[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    const body = init.body ?? (typeof input !== "string" ? input.body : undefined);
    const p = url.pathname;
    if (url.origin === SB) {
      if (p === "/auth/v1/user") return json({ id: UID, aud: "authenticated", role: "authenticated" });
      if (p === "/rest/v1/drafts" && method === "GET") {
        let rows = state.drafts;
        const id = url.searchParams.get("id"), uid = url.searchParams.get("user_id"), st = url.searchParams.get("status");
        if (id) rows = rows.filter((d) => `eq.${d.id}` === id);
        if (uid) rows = rows.filter((d) => `eq.${d.user_id}` === uid);
        if (st) rows = rows.filter((d) => `eq.${d.status}` === st);
        const accept = new Headers(init.headers || (typeof input !== "string" ? input.headers : {})).get("accept") || "";
        if (accept.includes("vnd.pgrst.object")) return rows[0] ? json(rows[0]) : json({ code: "PGRST116", message: "no rows" }, 406);
        return json(rows, 200);
      }
      if (p === "/rest/v1/drafts" && method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": "0-0/1" } });
      if (p === "/rest/v1/drafts" && method === "PATCH") {
        patches.push({ id: url.searchParams.get("id")!.slice(3), body: JSON.parse(body) });
        return new Response(null, { status: 204 });
      }
      if (p === "/rest/v1/social_accounts") {
        const cid = url.searchParams.get("cubicle_id"), uid = url.searchParams.get("user_id");
        return json(state.accounts.filter((a) => `eq.${a.cubicle_id}` === cid && `eq.${a.user_id}` === uid));
      }
      if (p === "/rest/v1/cubicles") return json({ name: "Satyr Coffee", logo_url: null });
      const dl = p.match(/^\/storage\/v1\/object\/(?:authenticated\/)?post-media\/(.+)$/);
      if (dl && method === "GET") {
        const f = state.files[decodeURIComponent(dl[1])];
        return f ? new Response(f as BodyInit, { status: 200 }) : json({ statusCode: "404", error: "not_found", message: "Object not found" }, 400);
      }
      const sg = p.match(/^\/storage\/v1\/object\/sign\/post-media\/(.+)$/);
      if (sg && method === "POST") return json({ signedURL: `/object/sign/post-media/${sg[1]}?token=SIGNED` });
      return json({ message: "unmocked supabase " + method + " " + p }, 599);
    }
    if (url.hostname === "discord.com") { discordForms.push(body as FormData); return json({ id: "msg-" + discordForms.length }); }
    if (url.hostname === "graph.facebook.com") return json({ id: "fbphoto", post_id: "PAGE1_7" });
    return json({ error: "unmocked " + url }, 599);
  }) as typeof fetch;
  return { patches, discordForms, restore: () => { globalThis.fetch = orig; } };
}

const baseDraft = { id: "d1", user_id: UID, cubicle_id: CID, content: "Fresh roast today", status: "draft", target_platforms: ["discord", "facebook"], platform_options: null, image_url: null, video_url: null };
const accounts = [
  { id: "a1", user_id: UID, cubicle_id: CID, platform: "discord", access_token: WEBHOOK, external_account_name: "#news" },
  { id: "a2", user_id: UID, cubicle_id: CID, platform: "facebook", access_token: "pagetok", external_account_id: "PAGE1" },
];

Deno.test("publish-post: uploaded image reaches Discord as an attachment and Facebook as a signed URL", async () => {
  const img = await jpeg(64, 64);
  const fx = fakeSupabase({ drafts: [{ ...baseDraft, media: [{ path: P("x.jpg"), kind: "image", mime: "image/jpeg", size: img.length, name: "x.jpg" }] }], accounts, files: { [P("x.jpg")]: img } });
  try {
    const res = await publishPost(new Request("http://localhost/publish-post", { method: "POST", headers: { Authorization: "Bearer user-jwt", "content-type": "application/json" }, body: JSON.stringify({ draft_id: "d1" }) }));
    const out = await res.json();
    assertEquals(res.status, 200, JSON.stringify(out));
    assert(out.results.discord.ok, out.results.discord.error);
    assert(out.results.facebook.ok, out.results.facebook.error);
    assertEquals((fx.discordForms[0].get("files[0]") as File).size, img.length);
    assertEquals(fx.patches.at(-1)!.body.status, "published");
  } finally { fx.restore(); }
});

Deno.test("publish-post: a draft pointing at someone else's file is refused before anything is posted", async () => {
  const fx = fakeSupabase({ drafts: [{ ...baseDraft, media: [{ path: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/secret.jpg", kind: "image", mime: "image/jpeg", size: 10 }] }], accounts, files: {} });
  try {
    const res = await publishPost(new Request("http://localhost/publish-post", { method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify({ draft_id: "d1" }) }));
    const out = await res.json();
    assertEquals(res.status, 400);
    assertEquals(out.error, "media_forbidden_path");
    assertEquals(fx.discordForms.length, 0);
  } finally { fx.restore(); }
});

Deno.test("publish-post: a too-long video is rejected server-side (real bytes), nothing posted", async () => {
  const long = fakeMp4(120);
  const fx = fakeSupabase({ drafts: [{ ...baseDraft, media: [{ path: P("long.mp4"), kind: "video", mime: "video/mp4", size: long.length, duration: 30 }] }], accounts, files: { [P("long.mp4")]: long } });
  try {
    const res = await publishPost(new Request("http://localhost/publish-post", { method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify({ draft_id: "d1" }) }));
    const out = await res.json();
    assertEquals(res.status, 400);
    assertEquals(out.error, "media_too_long");
    assertStringIncludes(out.message, "90s");
    assertEquals(fx.discordForms.length, 0);
  } finally { fx.restore(); }
});

Deno.test("cron: scheduled post with an uploaded video publishes; deleted file hands the post back as a draft", async () => {
  const mp4 = fakeMp4(10);
  const fx = fakeSupabase({
    drafts: [
      { ...baseDraft, id: "s1", status: "scheduled", scheduled_for: "2026-10-01T00:00:00Z", target_platforms: ["discord"], media: [{ path: P("v.mp4"), kind: "video", mime: "video/mp4", size: mp4.length, duration: 10 }] },
      { ...baseDraft, id: "s2", status: "scheduled", scheduled_for: "2026-10-01T00:00:00Z", target_platforms: ["discord"], media: [{ path: P("deleted.jpg"), kind: "image", mime: "image/jpeg", size: 10 }] },
    ],
    accounts, files: { [P("v.mp4")]: mp4 },
  });
  try {
    const unauth = await cronPublish(new Request("http://localhost/cron", { method: "POST" }));
    assertEquals(unauth.status, 401);
    const res = await cronPublish(new Request("http://localhost/cron", { method: "POST", headers: { "x-cron-secret": "cron-secret-test" } }));
    const out = await res.json();
    assertEquals(res.status, 200, JSON.stringify(out));
    assertEquals(out.processed, 2);
    const s1 = fx.patches.find((x) => x.id === "s1")!.body;
    assertEquals(s1.status, "published");
    assertEquals((fx.discordForms[0].get("files[0]") as File).type, "video/mp4");
    const s2 = fx.patches.find((x) => x.id === "s2")!.body;
    assertEquals(s2.status, "draft");
    assertStringIncludes(s2.publish_error, "media_missing");
  } finally { fx.restore(); }
});
