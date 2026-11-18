import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// mastodon-oauth-callback (2026-11-18)
// Mirrors pinterest/tumblr-oauth-callback's shape, with one difference: the
// client_id/secret aren't baked into app.html (Mastodon has no single central
// app) — they're looked up per-instance from mastodon_apps, populated by
// mastodon-connect. `state` carries "<cubicle_id>::<instance>" through the
// redirect so this callback knows which instance to exchange the code with.

const REDIRECT_URI = "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/mastodon-oauth-callback";
const SITE_APP_URL = "https://brandparent.app/app.html";

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const oauthError = url.searchParams.get("error");
  const sep = state.indexOf("::");
  const cubicleId = sep === -1 ? "" : state.slice(0, sep);
  const instance = sep === -1 ? "" : state.slice(sep + 2);

  if (oauthError || !code || !cubicleId || !instance) {
    return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent(oauthError || "missing_code")}`, 302);
  }

  try {
    const svc = getServiceClient();

    const { data: appRow } = await svc.from("mastodon_apps").select("client_id, client_secret").eq("instance", instance).maybeSingle();
    if (!appRow) return Response.redirect(`${SITE_APP_URL}?connect_error=mastodon_app_missing`, 302);

    const tokenResp = await fetch(`https://${instance}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: appRow.client_id,
        client_secret: appRow.client_secret,
        redirect_uri: REDIRECT_URI,
        scope: "read write",
      }),
    });
    const token: any = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !token.access_token) {
      return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent("mastodon_token_error: " + JSON.stringify(token))}`, 302);
    }

    const meResp = await fetch(`https://${instance}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const me: any = await meResp.json().catch(() => ({}));
    if (!meResp.ok || !me.id) {
      return Response.redirect(`${SITE_APP_URL}?connect_error=mastodon_verify_failed`, 302);
    }

    const { data: cubicle } = await svc.from("cubicles").select("user_id").eq("id", cubicleId).single();
    if (!cubicle) return Response.redirect(`${SITE_APP_URL}?connect_error=cubicle_not_found`, 302);

    const { error: upsertErr } = await svc.from("social_accounts").upsert({
      user_id: cubicle.user_id,
      cubicle_id: cubicleId,
      platform: "mastodon",
      external_account_id: String(me.id),
      external_account_name: `@${me.username}@${instance}`,
      access_token: token.access_token,
      account_meta: { instance },
      connected_at: new Date().toISOString(),
    }, { onConflict: "cubicle_id,platform" });

    if (upsertErr) {
      return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent("db_error: " + upsertErr.message)}`, 302);
    }

    return Response.redirect(`${SITE_APP_URL}?connected=Mastodon`, 302);
  } catch (e) {
    return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent(String(e))}`, 302);
  }
});
