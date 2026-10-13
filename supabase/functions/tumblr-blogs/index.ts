import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { tumblrAccountName, type TumblrBlog } from "../_shared/tumblr.ts";

// tumblr-blogs: lets the owner choose which of their Tumblr blogs a brand posts to.
//   { action: "list",   cubicle_id }           -> { blogs, selected }
//   { action: "select", cubicle_id, blog_uuid } -> { ok, blog_name }
// Only blogs saved at connect time (account_meta.blogs) can be selected.

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
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, anon, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { action, cubicle_id, blog_uuid } = await req.json().catch(() => ({}));
    if (!cubicle_id) return json({ error: "missing_cubicle_id" }, 400);
    const svc = svcClient();
    const { data: acct } = await svc.from("social_accounts").select("id, external_account_id, account_meta")
      .eq("cubicle_id", cubicle_id).eq("user_id", user.id).eq("platform", "tumblr").maybeSingle();
    if (!acct) return json({ error: "tumblr_not_connected", message: "Tumblr isn't connected for this brand." }, 404);
    const blogs: TumblrBlog[] = acct.account_meta?.blogs || [];

    if (action === "list") return json({ blogs, selected: acct.external_account_id });
    if (action === "select") {
      const blog = blogs.find((b) => b.uuid === blog_uuid);
      if (!blog) return json({ error: "unknown_blog", message: "That blog isn't on this Tumblr login. Reconnect Tumblr to refresh the list." }, 400);
      const { error } = await svc.from("social_accounts").update({ external_account_id: blog.uuid, external_account_name: tumblrAccountName(blog) }).eq("id", acct.id);
      if (error) return json({ error: "save_failed", message: String(error.message || error) }, 500);
      return json({ ok: true, blog_name: tumblrAccountName(blog) });
    }
    return json({ error: "bad_action" }, 400);
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
