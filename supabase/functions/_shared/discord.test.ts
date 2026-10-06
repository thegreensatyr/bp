// Run: deno test supabase/functions/_shared/discord.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { collectDiscordImages, parseDiscordWebhookUrl, publishToDiscord, splitForDiscord } from "./discord.ts";

const ID = "123456789012345678";
const TOKEN = "fake-test-token-not-a-real-webhook-" + "0".repeat(40); // gitleaks:allow (test fixture)
const GOOD = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

Deno.test("parse: accepts canonical, versioned, trailing slash and query forms", () => {
  assertEquals(parseDiscordWebhookUrl(GOOD)?.url, GOOD);
  assertEquals(parseDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`)?.url, GOOD);
  assertEquals(parseDiscordWebhookUrl(`  ${GOOD}/  `)?.url, GOOD);
  assertEquals(parseDiscordWebhookUrl(`${GOOD}?wait=true`)?.id, ID);
});

Deno.test("parse: rejects other hosts, schemes and shapes", () => {
  for (const bad of [
    `http://discord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://discordapp.com/api/webhooks/${ID}/${TOKEN}`,
    `https://evil.com/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com.evil.com/api/webhooks/${ID}/${TOKEN}`,
    `https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`,
    `https://discord.com/api/webhooks/${ID}`,
    `https://discord.com/api/webhooks/notanid/${TOKEN}`,
    `https://discord.com/api/webhooks/${ID}/${TOKEN}/slack`,
    `https://discord.com/api/channels/${ID}/messages`,
    "", 42, null,
  ]) assertEquals(parseDiscordWebhookUrl(bad), null, String(bad));
});

Deno.test("split: short text is one chunk, long text splits at boundaries under 2000", () => {
  assertEquals(splitForDiscord("hello"), ["hello"]);
  const para = "word ".repeat(300).trim(); // ~1500 chars
  const text = `${para}\n\n${para}\n\n${para}`;
  const chunks = splitForDiscord(text);
  assert(chunks.length >= 3);
  for (const c of chunks) assert(c.length <= 2000, `chunk ${c.length}`);
  assertEquals(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  const noSpaces = "x".repeat(4500);
  assertEquals(splitForDiscord(noSpaces).map((c) => c.length), [2000, 2000, 500]);
});

Deno.test("collect images: main + extras, deduped, max 4, http(s) only", () => {
  const imgs = collectDiscordImages({
    image_url: "https://a/1.png",
    platform_options: { discord: { extra_image_urls: ["https://a/1.png", "https://a/2.png", "javascript:alert(1)", "https://a/3.png", "https://a/4.png", "https://a/5.png"] } },
  });
  assertEquals(imgs, ["https://a/1.png", "https://a/2.png", "https://a/3.png", "https://a/4.png"]);
  assertEquals(collectDiscordImages({ image_url: null, platform_options: null }), []);
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

Deno.test("publish: one message with 4 image embeds, brand name/avatar, mentions disabled", async () => {
  let n = 0;
  const m = mockFetch(() => new Response(JSON.stringify({ id: `m${++n}` }), { status: 200 }));
  try {
    const r = await publishToDiscord(GOOD, {
      content: "Hello @everyone",
      imageUrls: ["https://i/1.png", "https://i/2.png", "https://i/3.png", "https://i/4.png", "https://i/5.png"],
      username: "DJ Green Satyr",
      avatarUrl: "https://i/logo.png",
    });
    assertEquals(r.post_id, "m1");
    assertEquals(m.calls.length, 1);
    assertEquals(m.calls[0].url, `${GOOD}?wait=true`);
    const b = m.calls[0].body;
    assertEquals(b.content, "Hello @everyone");
    assertEquals(b.allowed_mentions, { parse: [] });
    assertEquals(b.username, "DJ Green Satyr");
    assertEquals(b.avatar_url, "https://i/logo.png");
    assertEquals(b.embeds.length, 4);
    assert(b.embeds.every((e: any) => e.url === "https://i/1.png"));
  } finally { m.restore(); }
});

Deno.test("publish: long text is split; images only on last message; username containing 'discord' dropped", async () => {
  let n = 0;
  const m = mockFetch(() => new Response(JSON.stringify({ id: `m${++n}` }), { status: 200 }));
  try {
    const r = await publishToDiscord(GOOD, { content: "word ".repeat(900), imageUrls: ["https://i/1.png"], username: "My Discord Brand" });
    assertEquals(m.calls.length, 3);
    assert(m.calls.every((c) => (c.body.content || "").length <= 2000));
    assertEquals(m.calls[0].body.embeds, undefined);
    assertEquals(m.calls[2].body.embeds.length, 1);
    assertEquals(m.calls[0].body.username, undefined);
    assertEquals(r.message_ids, ["m1", "m2", "m3"]);
    assert(r.note?.includes("split into 3"));
  } finally { m.restore(); }
});

Deno.test("publish: deleted webhook gives a reconnect error without leaking the URL", async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ message: "Unknown Webhook" }), { status: 404 }));
  try {
    const err = await assertRejects(() => publishToDiscord(GOOD, { content: "hi" }));
    assert(String(err).includes("discord_webhook_gone"));
    assert(!String(err).includes(TOKEN));
  } finally { m.restore(); }
});

Deno.test("publish: failure after a partial send returns ok-with-note (no duplicate retries)", async () => {
  let n = 0;
  const m = mockFetch(() => (++n === 1 ? new Response(JSON.stringify({ id: "m1" }), { status: 200 }) : new Response("boom", { status: 500 })));
  try {
    const r = await publishToDiscord(GOOD, { content: "word ".repeat(900) });
    assertEquals(r.message_ids, ["m1"]);
    assert(r.note?.startsWith("only 1 of"));
  } finally { m.restore(); }
});

Deno.test("publish: retries once after 429", async () => {
  let n = 0;
  const m = mockFetch(() => (++n === 1
    ? new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 })
    : new Response(JSON.stringify({ id: "m1" }), { status: 200 })));
  try {
    const r = await publishToDiscord(GOOD, { content: "hi" });
    assertEquals(r.post_id, "m1");
    assertEquals(m.calls.length, 2);
  } finally { m.restore(); }
});

Deno.test("publish: rejects invalid stored webhook", async () => {
  await assertRejects(() => publishToDiscord("https://evil.com/x", { content: "hi" }), Error, "discord_bad_webhook");
});
