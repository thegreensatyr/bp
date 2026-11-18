import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// mastodon-connect (2026-11-18)
// Unlike Meta/Pinterest/TikTok, Mastodon has no central developer console: any
// client can self-register an OAuth app on any instance via POST /api/v1/apps,
// instantly, no review. So instead of a single client_id baked into app.html,
// this function registers (or reuses a cached) app per-instance, then hands the
// browser the authorize URL to redirect to. The callback is mastodon-oauth-callback.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

const REDIRECT_URI = "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/mastodon-oauth-callback";
const SCOPES = "read write";

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

/** Accepts "mastodon.social", "https://mastodon.social/" etc. Returns a bare host or null. */
function cleanInstance(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^@/, "");
  if (!h || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return null;
  return h;
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
    const { cubicle_id, instance: rawInstance } = body as { cubicle_id?: string; instance?: string };
    if (!cubicle_id || !rawInstance) {
      return json({ error: "missing_fields", message: "cubicle_id and instance are both required" }, 400);
    }

    const instance = cleanInstance(rawInstance);
    if (!instance) {
      return json({ error: "invalid_instance", message: "That doesn't look like a Mastodon server address. Enter just the domain, like mastodon.social." }, 400);
    }

    const svc = getServiceClient();

    // Confirm the cubicle actually belongs to this user before registering anything.
    const { data: cubicle, error: cubicleErr } = await svc.from("cubicles").select("id").eq("id", cubicle_id).eq("user_id", user.id).single();
    if (cubicleErr || !cubicle) return json({ error: "cubicle_not_found" }, 404);

    let appRow: { client_id: string; client_secret: string } | null = null;
    const { data: existing } = await svc.from("mastodon_apps").select("client_id, client_secret").eq("instance", instance).maybeSingle();
    if (existing) {
      appRow = existing;
    } else {
      const regResp = await fetch(`https://${instance}/api/v1/apps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "BrandParent",
          redirect_uris: REDIRECT_URI,
          scopes: SCOPES,
          website: "https://brandparent.app",
        }),
      });
      const reg: any = await regResp.json().catch(() => ({}));
      if (!regResp.ok || !reg.client_id || !reg.client_secret) {
        return json({
          error: "mastodon_registration_failed",
          message: `Couldn't register BrandParent with "${instance}". Double-check the server address — it should be just the domain, like mastodon.social.`,
        }, 400);
      }
      appRow = { client_id: reg.client_id, client_secret: reg.client_secret };
      const { error: upsertAppErr } = await svc.from("mastodon_apps").upsert(
        { instance, client_id: reg.client_id, client_secret: reg.client_secret },
        { onConflict: "instance" },
      );
      if (upsertAppErr) return json({ error: "db_error", message: upsertAppErr.message }, 500);
    }

    const state = `${cubicle_id}::${instance}`;
    const authUrl = `https://${instance}/oauth/authorize?client_id=${encodeURIComponent(appRow.client_id)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}` +
      `&state=${encodeURIComponent(state)}`;

    return json({ ok: true, url: authUrl });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
