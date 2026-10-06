import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { freshTikTokToken, tiktokCreatorInfo } from "./tiktok.ts";

// tiktok-creator-info (v1, 2026-09-23)
// POST {cubicle_id} -> the connected TikTok creator's nickname, avatar, allowed
// privacy levels and interaction settings. The app shows these in the TikTok
// panel before every post (TikTok audit requirement).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const pub = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const anon = pub ? JSON.parse(pub).default : Deno.env.get("SUPABASE_ANON_KEY")!;
    const sec = Deno.env.get("SUPABASE_SECRET_KEYS");
    const svcKey = sec ? JSON.parse(sec).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized", message: "Your session has expired — please log in again." }, 401);

    const { cubicle_id } = await req.json().catch(() => ({}));
    if (!cubicle_id) return json({ error: "missing_cubicle_id", message: "No brand selected." }, 400);

    const svc = createClient(url, svcKey);
    const { data: acct } = await svc.from("social_accounts").select("*")
      .eq("cubicle_id", cubicle_id).eq("user_id", user.id).eq("platform", "tiktok").maybeSingle();
    if (!acct) return json({ error: "not_connected", message: "TikTok isn't connected for this brand." }, 404);

    const token = await freshTikTokToken(svc, acct);
    const info = await tiktokCreatorInfo(token);
    return json({ ok: true, account_name: acct.external_account_name, ...info });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    return json({ error: "tiktok_error", message: msg.replace(/^tiktok_[a-z_]+:\s*/, "") }, 502);
  }
});
