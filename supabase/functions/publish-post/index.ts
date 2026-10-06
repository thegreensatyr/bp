import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { publishToAccounts, summarize } from "../_shared/publish.ts";
import { DraftMedia, MediaError } from "../_shared/media.ts";

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
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ? JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!).default : Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { draft_id } = await req.json();
    if (!draft_id) return new Response(JSON.stringify({ error: "missing_draft_id" }), { status: 400, headers: CORS_HEADERS });

    const svc = getServiceClient();

    const { data: draft, error: draftErr } = await svc.from("drafts").select("*").eq("id", draft_id).eq("user_id", user.id).single();
    if (draftErr || !draft) {
      return new Response(JSON.stringify({ error: "draft_not_found" }), { status: 404, headers: CORS_HEADERS });
    }

    const { data: allAccounts } = await svc.from("social_accounts").select("*").eq("cubicle_id", draft.cubicle_id).eq("user_id", draft.user_id);
    // ^ user_id filter: a draft may only ever publish through accounts owned by the draft's author,
    //   even if its cubicle_id points at someone else's cubicle.
    const accounts = (draft.target_platforms && draft.target_platforms.length)
      ? (allAccounts || []).filter((a: any) => draft.target_platforms.includes(a.platform))
      : (allAccounts || []);

    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ error: "no_connected_accounts" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // Media: validate drafts.media (owner's folder only, PNG/JPEG/MP4, counts)
    // and check the real bytes (type sniff, size, video length) BEFORE anything
    // is posted, so a bad file never produces a half-published post.
    let media: DraftMedia;
    try {
      media = new DraftMedia(svc, draft);
      await media.prepare();
    } catch (e) {
      const permanent = e instanceof MediaError && e.permanent;
      const message = String((e as Error)?.message || e);
      await svc.from("drafts").update({ publish_error: message }).eq("id", draft_id);
      return new Response(JSON.stringify({ error: e instanceof MediaError ? e.code : "media_error", message }), {
        status: permanent ? 400 : e instanceof MediaError ? 503 : 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const results = await publishToAccounts(svc, draft, accounts, media);
    const { anySucceeded, allErrors, firstPostId } = summarize(results);

    await svc.from("drafts").update({
      status: anySucceeded ? "published" : draft.status,
      published_at: anySucceeded ? new Date().toISOString() : null,
      platform_post_id: firstPostId,
      publish_error: allErrors || null,
    }).eq("id", draft_id);

    return new Response(JSON.stringify({ results }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "server_error", message: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
