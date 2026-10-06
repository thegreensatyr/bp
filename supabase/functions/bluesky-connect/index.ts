import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ? JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!).default : Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { cubicle_id, handle, app_password } = await req.json();
    if (!cubicle_id || !handle || !app_password) {
      return new Response(JSON.stringify({ error: "missing_fields", message: "cubicle_id, handle, and app_password are all required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const cleanHandle = handle.trim().replace(/^@/, "");

    const svc = getServiceClient();

    // confirm the cubicle actually belongs to this user before storing anything
    const { data: cubicle, error: cubicleErr } = await svc.from("cubicles").select("id").eq("id", cubicle_id).eq("user_id", user.id).single();
    if (cubicleErr || !cubicle) {
      return new Response(JSON.stringify({ error: "cubicle_not_found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // validate the app password by creating a session against the AT Protocol
    const sessionResp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: cleanHandle, password: app_password }),
    });
    const session = await sessionResp.json();
    if (!sessionResp.ok) {
      return new Response(JSON.stringify({ error: "bluesky_auth_failed", message: session?.message || "Bluesky rejected that handle/app password combination." }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { error: upsertErr } = await svc.from("social_accounts").upsert({
      user_id: user.id,
      cubicle_id,
      platform: "bluesky",
      external_account_id: session.did,
      external_account_name: session.handle,
      access_token: app_password,
      connected_at: new Date().toISOString(),
    }, { onConflict: "cubicle_id,platform" });

    if (upsertErr) {
      return new Response(JSON.stringify({ error: "db_error", message: upsertErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, handle: session.handle, did: session.did }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "server_error", message: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
