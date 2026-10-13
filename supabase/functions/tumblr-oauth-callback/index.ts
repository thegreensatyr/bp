import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleTumblrCallback } from "../_shared/tumblr.ts";

// Tumblr OAuth2 redirect target (TUMBLR_REDIRECT_URI). Saves tokens + the user's
// blogs (primary blog selected); sends the browser to the blog picker when the
// login has more than one blog. Deploy with --no-verify-jwt (browser redirect).

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

Deno.serve(async (req: Request) => Response.redirect(await handleTumblrCallback(req.url, getServiceClient()), 302));
