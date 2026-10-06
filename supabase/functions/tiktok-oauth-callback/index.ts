import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// tiktok-oauth-callback (v2, 2026-09-23)
// - Stores refresh_token + its expiry (TikTok access tokens die after ~24h;
//   without the refresh token every TikTok post would fail the next day).
// - Returns the user to the SAME cubicle they connected from.
// - Friendlier error codes.

const REDIRECT_URI = "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/tiktok-oauth-callback";
const SITE_APP_URL = "https://brandparent.app/app.html";

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

function back(params: Record<string, string>) {
  const q = new URLSearchParams(params).toString();
  return Response.redirect(`${SITE_APP_URL}?${q}`, 302);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const cubicleId = url.searchParams.get("state") || "";
  const oauthError = url.searchParams.get("error");

  if (oauthError || !code || !cubicleId) {
    const desc = url.searchParams.get("error_description") || oauthError || "missing_code";
    return back({ connect_error: "TikTok: " + desc, cubicle: cubicleId });
  }

  const CLIENT_KEY = Deno.env.get("TIKTOK_CLIENT_KEY");
  const CLIENT_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET");
  if (!CLIENT_KEY || !CLIENT_SECRET) {
    return back({ connect_error: "TikTok isn't fully set up yet (missing app key/secret on the server).", cubicle: cubicleId });
  }

  try {
    const tokenResp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const token = await tokenResp.json();
    if (!tokenResp.ok || !token.access_token) {
      console.error(JSON.stringify({ diagnostic: "tiktok_token_error", token }));
      return back({ connect_error: "TikTok login failed: " + (token.error_description || token.error || "token exchange error"), cubicle: cubicleId });
    }

    const meResp = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const me = await meResp.json();
    const info = me?.data?.user;
    if (!meResp.ok || !info) {
      console.error(JSON.stringify({ diagnostic: "tiktok_userinfo_error", me }));
      return back({ connect_error: "Connected to TikTok but couldn't read the account name.", cubicle: cubicleId });
    }

    const svc = getServiceClient();
    const { data: cubicle } = await svc.from("cubicles").select("user_id").eq("id", cubicleId).single();
    if (!cubicle) return back({ connect_error: "That brand wasn't found.", cubicle: cubicleId });

    const now = Date.now();
    const { error: upErr } = await svc.from("social_accounts").upsert({
      user_id: cubicle.user_id,
      cubicle_id: cubicleId,
      platform: "tiktok",
      external_account_id: token.open_id || info.open_id,
      external_account_name: info.display_name || "TikTok account",
      access_token: token.access_token,
      token_expires_at: token.expires_in ? new Date(now + token.expires_in * 1000).toISOString() : null,
      refresh_token: token.refresh_token || null,
      refresh_expires_at: token.refresh_expires_in ? new Date(now + token.refresh_expires_in * 1000).toISOString() : null,
      connected_at: new Date().toISOString(),
    }, { onConflict: "cubicle_id,platform" });
    if (upErr) {
      console.error(JSON.stringify({ diagnostic: "tiktok_save_error", upErr }));
      return back({ connect_error: "TikTok connected but saving failed: " + upErr.message, cubicle: cubicleId });
    }

    return back({ connected: "TikTok", cubicle: cubicleId });
  } catch (e) {
    return back({ connect_error: "TikTok error: " + String(e), cubicle: cubicleId });
  }
});
