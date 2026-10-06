import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a signed-in user pick WHICH Facebook Page belongs to a cubicle after
// connecting Facebook (the OAuth callback stores every granted Page in
// meta_pending_pages). Page tokens never leave the server.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const PENDING_TTL_MS = 60 * 60 * 1000; // pending Page list is valid for 1 hour

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function admin() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = raw ? JSON.parse(raw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(Deno.env.get("SUPABASE_URL")!, key);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const supabase = admin();
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "not_signed_in" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const cubicleId = String(body.cubicle_id || "");
    if (!cubicleId) return json({ error: "missing_cubicle_id" }, 400);

    const { data: cubicle } = await supabase.from("cubicles").select("id,user_id,name").eq("id", cubicleId).single();
    if (!cubicle || cubicle.user_id !== userId) return json({ error: "cubicle_not_found" }, 404);

    const since = new Date(Date.now() - PENDING_TTL_MS).toISOString();
    const { data: pending, error: pendErr } = await supabase
      .from("meta_pending_pages")
      .select("page_id,page_name,page_token,ig_id,ig_username")
      .eq("cubicle_id", cubicleId).eq("user_id", userId).gte("created_at", since)
      .order("page_name", { ascending: true });
    if (pendErr) return json({ error: "lookup_failed", message: pendErr.message }, 500);

    if (action === "list") {
      return json({
        cubicle_name: cubicle.name,
        pages: (pending || []).map((p) => ({ page_id: p.page_id, page_name: p.page_name, ig_username: p.ig_username })),
      });
    }

    if (action === "select") {
      const pageId = String(body.page_id || "");
      const page = (pending || []).find((p) => p.page_id === pageId);
      if (!page) return json({ error: "page_not_found", message: "That Page list expired. Connect Facebook again." }, 404);

      const { error: fbErr } = await supabase.from("social_accounts").upsert({
        user_id: userId, cubicle_id: cubicleId, platform: "facebook",
        external_account_id: page.page_id, external_account_name: page.page_name,
        access_token: page.page_token, token_expires_at: null,
      }, { onConflict: "cubicle_id,platform" });
      if (fbErr) return json({ error: "save_failed", message: fbErr.message }, 500);

      if (page.ig_id) {
        const { error: igErr } = await supabase.from("social_accounts").upsert({
          user_id: userId, cubicle_id: cubicleId, platform: "instagram",
          external_account_id: page.ig_id, external_account_name: page.ig_username || page.page_name,
          access_token: page.page_token, token_expires_at: null,
        }, { onConflict: "cubicle_id,platform" });
        if (igErr) return json({ error: "save_failed", message: igErr.message }, 500);
      } else {
        // The chosen Page has no Instagram linked: drop any Instagram link left over from a different Page.
        await supabase.from("social_accounts").delete().eq("cubicle_id", cubicleId).eq("platform", "instagram");
      }

      await supabase.from("meta_pending_pages").delete().eq("cubicle_id", cubicleId);
      return json({ ok: true, page_name: page.page_name, instagram: page.ig_username || null });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(JSON.stringify({ diagnostic: "meta_pages_error", message: String(e) }));
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
