import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseDiscordWebhookUrl } from "../_shared/discord.ts";

// discord-connect (2026-10-05)
// Connects ONE cubicle to ONE Discord channel via a pasted channel webhook URL.
// Mirrors bluesky-connect: user JWT -> ownership check -> verify with the
// platform -> upsert social_accounts with the service role.
// The webhook URL is a credential: it is stored in social_accounts.access_token
// and is never echoed back to the browser or logged.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ? JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!).default : Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const { cubicle_id, webhook_url, label } = body as { cubicle_id?: string; webhook_url?: string; label?: string };
    if (!cubicle_id || !webhook_url) {
      return json({ error: "missing_fields", message: "cubicle_id and webhook_url are both required" }, 400);
    }

    const parsed = parseDiscordWebhookUrl(webhook_url);
    if (!parsed) {
      return json({
        error: "invalid_webhook_url",
        message: "That isn't a Discord channel webhook URL. It should look like https://discord.com/api/webhooks/123…/abc… — copy it from Server Settings → Integrations → Webhooks.",
      }, 400);
    }

    const svc = getServiceClient();

    // Confirm the cubicle belongs to this user before storing anything.
    const { data: cubicle, error: cubicleErr } = await svc.from("cubicles").select("id").eq("id", cubicle_id).eq("user_id", user.id).single();
    if (cubicleErr || !cubicle) return json({ error: "cubicle_not_found" }, 404);

    // Verify the webhook with Discord. GET with the token returns the webhook
    // object (no message is posted). It does not include channel/server names.
    let hook: any;
    try {
      const resp = await fetch(parsed.url, { method: "GET", headers: { "accept": "application/json" } });
      if (resp.status === 404 || resp.status === 401) {
        return json({ error: "webhook_not_found", message: "Discord says that webhook doesn't exist (it may have been deleted). Create a new webhook and paste its URL." }, 400);
      }
      if (!resp.ok) return json({ error: "discord_unreachable", message: `Discord returned HTTP ${resp.status} while checking the webhook. Try again in a minute.` }, 502);
      hook = await resp.json();
    } catch (_e) {
      return json({ error: "discord_unreachable", message: "Couldn't reach Discord to check the webhook. Try again in a minute." }, 502);
    }
    if (String(hook?.id) !== parsed.id || Number(hook?.type) !== 1) {
      return json({ error: "not_incoming_webhook", message: "That URL isn't a normal channel webhook. Create one under Server Settings → Integrations → Webhooks." }, 400);
    }

    const cleanLabel = typeof label === "string" ? label.trim().replace(/\s+/g, " ").slice(0, 80) : "";
    const accountName = cleanLabel || `${String(hook.name || "Webhook").slice(0, 60)} (channel ${hook.channel_id})`;

    const { error: upsertErr } = await svc.from("social_accounts").upsert({
      user_id: user.id,
      cubicle_id,
      platform: "discord",
      external_account_id: parsed.id,
      external_account_name: accountName,
      access_token: parsed.url,
      refresh_token: null,
      token_expires_at: null,
      connected_at: new Date().toISOString(),
    }, { onConflict: "cubicle_id,platform" });

    if (upsertErr) {
      if ((upsertErr as any).code === "23514") {
        // social_accounts_platform_check doesn't list 'discord' yet.
        return json({ error: "discord_not_enabled", message: "Discord support isn't switched on in the database yet (pending migration add_discord_platform). Nothing was saved." }, 503);
      }
      return json({ error: "db_error", message: upsertErr.message }, 500);
    }

    // Deliberately do NOT return the webhook URL or token.
    return json({ ok: true, name: accountName, webhook_name: hook.name || null, channel_id: hook.channel_id || null, guild_id: hook.guild_id || null });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
