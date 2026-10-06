import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { publishToAccounts, summarize } from "../_shared/publish.ts";
import { DraftMedia, MediaError } from "../_shared/media.ts";

// CRON_SECRET must match the Vault secret `cron_publish_secret` that the
// pg_cron job `publish-scheduled-posts` sends in the x-cron-secret header.
// Set it with: supabase secrets set CRON_SECRET=... (never hard-code it here).
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function decodeJwtRole(jwt: string): string {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return "not_a_jwt";
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role || "no_role_claim";
  } catch {
    return "decode_failed";
  }
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  console.log(JSON.stringify({
    diagnostic: "service_client_key_source",
    used_secret_keys_json: !!keysRaw,
    jwt_role_claim: decodeJwtRole(key),
  }));
  return createClient(url, key);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(e: unknown) {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { name: "unknown", message: String(e) };
}

async function fetchDueDraftsWithRetry(svc: any, nowIso: string) {
  const maxAttempts = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await svc
        .from("drafts")
        .select("*")
        .eq("status", "scheduled")
        .lte("scheduled_for", nowIso)
        .limit(50);
      if (error) {
        return { data: null, error, attempts: attempt };
      }
      return { data, error: null, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
        continue;
      }
    }
  }
  return { data: null, error: null, thrown: lastErr, attempts: maxAttempts };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const providedSecret = req.headers.get("x-cron-secret");
  if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  let svc;
  try {
    svc = getServiceClient();
  } catch (e) {
    return new Response(JSON.stringify({ error: "service_client_error", detail: describeError(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const nowIso = new Date().toISOString();

    const dueResult = await fetchDueDraftsWithRetry(svc, nowIso);

    if (dueResult.error) {
      return new Response(JSON.stringify({ error: "query_error", message: (dueResult.error as any).message, attempts: dueResult.attempts }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (dueResult.thrown) {
      return new Response(JSON.stringify({ error: "query_retries_exhausted", detail: describeError(dueResult.thrown), attempts: dueResult.attempts }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const due = dueResult.data;

    try {
      const { count: totalScheduledCount, error: countErr } = await svc
        .from("drafts")
        .select("id", { count: "exact", head: true })
        .eq("status", "scheduled");
      console.log(JSON.stringify({
        diagnostic: "unfiltered_scheduled_count",
        total_scheduled_visible_to_this_client: totalScheduledCount,
        count_error: countErr ? countErr.message : null,
        due_now_count: (due || []).length,
        now_iso: nowIso,
      }));
    } catch (diagErr) {
      console.log(JSON.stringify({ diagnostic: "unfiltered_count_threw", detail: describeError(diagErr) }));
    }

    const summary: Record<string, unknown>[] = [];

    for (const draft of (due || []) as any[]) {
      const { data: allAccounts } = await svc.from("social_accounts").select("*").eq("cubicle_id", draft.cubicle_id).eq("user_id", draft.user_id);
      // ^ user_id filter: a draft may only ever publish through accounts owned by the draft's author,
      //   even if its cubicle_id points at someone else's cubicle.
      const accounts = (draft.target_platforms && draft.target_platforms.length)
        ? (allAccounts || []).filter((a: any) => draft.target_platforms.includes(a.platform))
        : (allAccounts || []);
      if (!accounts || accounts.length === 0) {
        await svc.from("drafts").update({ publish_error: "no_connected_accounts" }).eq("id", draft.id);
        summary.push({ draft_id: draft.id, error: "no_connected_accounts" });
        continue;
      }

      // Media problems that can't fix themselves (file deleted, wrong type, too
      // long, path outside the owner's folder) move the post back to "draft"
      // with the reason, instead of retrying every 5 minutes forever.
      // Transient ones (storage hiccup) leave it scheduled for the next run.
      let media: DraftMedia;
      try {
        media = new DraftMedia(svc, draft);
        await media.prepare();
      } catch (e) {
        const permanent = e instanceof MediaError && e.permanent;
        const message = String((e as Error)?.message || e);
        await svc.from("drafts").update({ publish_error: message, ...(permanent ? { status: "draft" } : {}) }).eq("id", draft.id);
        summary.push({ draft_id: draft.id, error: message, permanent });
        continue;
      }

      const results = await publishToAccounts(svc, draft, accounts, media);
      const { anySucceeded, onlySkips, allErrors, firstPostId } = summarize(results);

      await svc.from("drafts").update({
        // Every target skipped for a media reason: retrying won't help, so hand it back as a draft.
        status: anySucceeded ? "published" : onlySkips ? "draft" : draft.status,
        published_at: anySucceeded ? new Date().toISOString() : null,
        platform_post_id: firstPostId,
        publish_error: allErrors || null,
      }).eq("id", draft.id);

      summary.push({ draft_id: draft.id, results });
    }

    return new Response(JSON.stringify({ processed: (due || []).length, summary }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "server_error", detail: describeError(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
