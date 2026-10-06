import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// disconnect-account (2026-09-25)
// Removes one connected social account from ONE cubicle.
// - Only the owner can disconnect (checked against the logged-in user).
// - TikTok: also revokes BrandParent's access token on TikTok's side, so the
//   app truly loses access (TikTok's review expects this).
// - Other platforms: the stored tokens are deleted. We do NOT revoke at
//   Facebook/Meta level because one Meta login can back several cubicles.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function svcClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = raw ? JSON.parse(raw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const pubRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const anon = pubRaw ? JSON.parse(pubRaw).default : Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, anon, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { account_id } = await req.json().catch(() => ({}));
    if (!account_id) return json({ error: "missing_account_id" }, 400);

    const svc = svcClient();
    const { data: acct } = await svc.from("social_accounts").select("*").eq("id", account_id).eq("user_id", user.id).maybeSingle();
    if (!acct) return json({ error: "account_not_found" }, 404);

    let revoked: string = "not_applicable";
    if (acct.platform === "tiktok" && acct.access_token) {
      try {
        const r = await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
          body: new URLSearchParams({
            client_key: Deno.env.get("TIKTOK_CLIENT_KEY") || "",
            client_secret: Deno.env.get("TIKTOK_CLIENT_SECRET") || "",
            token: acct.access_token,
          }),
        });
        revoked = r.ok ? "revoked" : "revoke_failed_" + r.status;
      } catch (e) {
        revoked = "revoke_error";
        console.error(JSON.stringify({ diagnostic: "tiktok_revoke_error", e: String(e) }));
      }
    }

    const { error: delErr } = await svc.from("social_accounts").delete().eq("id", acct.id).eq("user_id", user.id);
    if (delErr) return json({ error: "delete_failed", message: delErr.message }, 500);

    return json({ ok: true, platform: acct.platform, revoked });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
