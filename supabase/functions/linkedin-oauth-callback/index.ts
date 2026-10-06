import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REDIRECT_URI = "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/linkedin-oauth-callback";
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
  const cubicleId = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError || !code || !cubicleId) {
    return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent(oauthError || "missing_code")}`, 302);
  }

  const CLIENT_ID = Deno.env.get("LINKEDIN_CLIENT_ID");
  const CLIENT_SECRET = Deno.env.get("LINKEDIN_CLIENT_SECRET");
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return Response.redirect(`${SITE_APP_URL}?connect_error=linkedin_not_configured`, 302);
  }

  try {
    const tokenResp = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const token = await tokenResp.json();
    if (!tokenResp.ok || !token.access_token) {
      return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent("linkedin_token_error: " + JSON.stringify(token))}`, 302);
    }

    const meResp = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const me = await meResp.json();
    if (!meResp.ok || !me.sub) {
      return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent("linkedin_userinfo_error: " + JSON.stringify(me))}`, 302);
    }

    const svc = getServiceClient();
    const { data: cubicle } = await svc.from("cubicles").select("user_id").eq("id", cubicleId).single();
    if (!cubicle) {
      return Response.redirect(`${SITE_APP_URL}?connect_error=cubicle_not_found`, 302);
    }

    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;

    await svc.from("social_accounts").upsert({
      user_id: cubicle.user_id,
      cubicle_id: cubicleId,
      platform: "linkedin",
      external_account_id: `urn:li:person:${me.sub}`,
      external_account_name: me.name || me.given_name || "LinkedIn member",
      access_token: token.access_token,
      token_expires_at: expiresAt,
      connected_at: new Date().toISOString(),
    }, { onConflict: "cubicle_id,platform" });

    return Response.redirect(`${SITE_APP_URL}?connected=LinkedIn`, 302);
  } catch (e) {
    return Response.redirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent(String(e))}`, 302);
  }
});
