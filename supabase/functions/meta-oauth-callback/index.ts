import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP_ID = "1536478337966065";
const REDIRECT_URI = "https://owxaolqikmgtlegtficq.supabase.co/functions/v1/meta-oauth-callback";
const SITE_APP_URL = "https://brandparent.app/app.html";
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"].join(",");

function facebookDialogUrl(state: string) {
  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=${encodeURIComponent(state)}&response_type=code`;
}

// Real HTTP 302 redirect. (Supabase serves Edge Function HTML as plain text,
// so the old <script> redirect showed raw code instead of navigating.)
function htmlRedirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state") || ""; // "<cubicle_id>" or "<cubicle_id>:reset"
  const wantsReset = rawState.endsWith(":reset");
  const state = wantsReset ? rawState.slice(0, -":reset".length) : rawState; // cubicle_id
  const error = url.searchParams.get("error");

  if (error) {
    return htmlRedirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return htmlRedirect(`${SITE_APP_URL}?connect_error=missing_code_or_state`);
  }

  try {
    const appSecret = Deno.env.get("META_APP_SECRET")!;

    // 1. Exchange code for a short-lived user access token
    const tokenResp = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${appSecret}&code=${code}`
    );
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) throw new Error("token_exchange_failed: " + JSON.stringify(tokenData));

    // 2. Exchange for a long-lived user access token (~60 days)
    const longResp = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`
    );
    const longData = await longResp.json();
    const userToken = longData.access_token || tokenData.access_token;

    // "Fix missing Pages": Facebook remembers which Pages were shared last time and
    // won't show the Page list again. Revoke BrandParent's access so Facebook forgets,
    // then send the user straight back to a fresh Page list. (Existing Page connections
    // for other brands are re-linked automatically below when they log back in.)
    if (wantsReset) {
      const revoke = await fetch(`https://graph.facebook.com/v21.0/me/permissions?access_token=${userToken}`, { method: "DELETE" });
      const revokeData = await revoke.json().catch(() => ({}));
      if (!revoke.ok || revokeData.success !== true) {
        throw new Error("reset_failed: " + JSON.stringify(revokeData));
      }
      return htmlRedirect(facebookDialogUrl(state));
    }

    // 3. Get EVERY Page this user granted (follow paging so none are missed)
    const pages: any[] = [];
    let next: string | null =
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${userToken}`;
    for (let guard = 0; next && guard < 10; guard++) {
      const r: Response = await fetch(next);
      const d: any = await r.json();
      if (d.error) throw new Error("pages_fetch_failed: " + JSON.stringify(d.error));
      pages.push(...(d.data || []));
      next = d.paging?.next || null;
    }

    if (pages.length === 0) {
      return htmlRedirect(`${SITE_APP_URL}?connect_error=no_pages_granted`);
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SECRET_KEYS") ? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Look up which user owns this cubicle so we can set user_id correctly under RLS-bypassing service role.
    const { data: cubicle, error: cubicleErr } = await supabase.from("cubicles").select("id,user_id").eq("id", state).single();
    if (cubicleErr || !cubicle) {
      return htmlRedirect(`${SITE_APP_URL}?connect_error=cubicle_not_found`);
    }

    // Keep every brand's existing Facebook/Instagram connection working: any Page this
    // user already connected to a brand gets its fresh token (old tokens die after a reset).
    for (const p of pages) {
      await supabase.from("social_accounts").update({ access_token: p.access_token })
        .eq("user_id", cubicle.user_id).eq("platform", "facebook").eq("external_account_id", p.id);
      if (p.instagram_business_account?.id) {
        await supabase.from("social_accounts").update({ access_token: p.access_token })
          .eq("user_id", cubicle.user_id).eq("platform", "instagram").eq("external_account_id", p.instagram_business_account.id);
      }
    }

    // Clear any earlier unfinished Page list for this cubicle.
    await supabase.from("meta_pending_pages").delete().eq("cubicle_id", cubicle.id);

    // More than one Page granted: never guess. Store them and let the user pick
    // which Page belongs to this brand (app.html shows the picker; meta-pages saves the choice).
    if (pages.length > 1) {
      const { error: pendErr } = await supabase.from("meta_pending_pages").insert(pages.map((p) => ({
        user_id: cubicle.user_id,
        cubicle_id: cubicle.id,
        page_id: p.id,
        page_name: p.name,
        page_token: p.access_token,
        ig_id: p.instagram_business_account?.id || null,
        ig_username: p.instagram_business_account?.username || null,
      })));
      if (pendErr) throw new Error("pending_save_failed: " + pendErr.message);
      return htmlRedirect(`${SITE_APP_URL}?pick_facebook=${encodeURIComponent(cubicle.id)}`);
    }

    // Exactly one Page granted: connect it directly.
    const page = pages[0];

    const { error: fbErr } = await supabase.from("social_accounts").upsert({
      user_id: cubicle.user_id,
      cubicle_id: cubicle.id,
      platform: "facebook",
      external_account_id: page.id,
      external_account_name: page.name,
      access_token: page.access_token,
      token_expires_at: null, // Page tokens from a long-lived user token don't expire
    }, { onConflict: "cubicle_id,platform" });
    if (fbErr) throw new Error("save_failed: " + fbErr.message);

    if (page.instagram_business_account?.id) {
      await supabase.from("social_accounts").upsert({
        user_id: cubicle.user_id,
        cubicle_id: cubicle.id,
        platform: "instagram",
        external_account_id: page.instagram_business_account.id,
        external_account_name: page.instagram_business_account.username || page.name,
        access_token: page.access_token,
        token_expires_at: null,
      }, { onConflict: "cubicle_id,platform" });
    } else {
      await supabase.from("social_accounts").delete().eq("cubicle_id", cubicle.id).eq("platform", "instagram");
    }

    return htmlRedirect(`${SITE_APP_URL}?connected=${encodeURIComponent("Facebook Page: " + page.name)}`);
  } catch (e) {
    return htmlRedirect(`${SITE_APP_URL}?connect_error=${encodeURIComponent(String(e))}`);
  }
});
