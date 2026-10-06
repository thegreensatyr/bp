import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { publishToTikTokFull } from "./tiktok.ts";
import { publishToDiscord, collectDiscordImages } from "../_shared/discord.ts";

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

async function publishToFacebook(pageId: string, pageToken: string, content: string, imageUrl?: string) {
  const endpoint = imageUrl
    ? `https://graph.facebook.com/v21.0/${pageId}/photos`
    : `https://graph.facebook.com/v21.0/${pageId}/feed`;
  const params = new URLSearchParams({ access_token: pageToken });
  if (imageUrl) { params.set("url", imageUrl); params.set("caption", content); }
  else { params.set("message", content); }

  const resp = await fetch(`${endpoint}?${params.toString()}`, { method: "POST" });
  const data = await resp.json();
  if (!resp.ok) throw new Error("facebook_error: " + JSON.stringify(data));
  return data.post_id || data.id;
}

async function publishToInstagram(igUserId: string, token: string, content: string, imageUrl?: string) {
  if (!imageUrl) {
    throw new Error("instagram_needs_image: Instagram requires an image or video with every post.");
  }
  const createResp = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption: content, access_token: token }),
  });
  const createData = await createResp.json();
  if (!createResp.ok || !createData.id) throw new Error("instagram_container_error: " + JSON.stringify(createData));

  const publishResp = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creation_id: createData.id, access_token: token }),
  });
  const publishData = await publishResp.json();
  if (!publishResp.ok || !publishData.id) throw new Error("instagram_publish_error: " + JSON.stringify(publishData));
  return publishData.id;
}

async function publishToBluesky(handle: string, appPassword: string, content: string, imageUrl?: string) {
  const sessionResp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  const session = await sessionResp.json();
  if (!sessionResp.ok) throw new Error("bluesky_auth_error: " + JSON.stringify(session));
  const { accessJwt, did } = session;

  let embed: Record<string, unknown> | undefined;
  if (imageUrl) {
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error("bluesky_image_fetch_error: could not download image_url");
    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    const bytes = new Uint8Array(await imgResp.arrayBuffer());
    if (bytes.byteLength > 976_560) {
      throw new Error("bluesky_image_too_large: image exceeds Bluesky's ~1MB upload limit");
    }
    const blobResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
      method: "POST",
      headers: { "content-type": contentType, "Authorization": `Bearer ${accessJwt}` },
      body: bytes,
    });
    const blobData = await blobResp.json();
    if (!blobResp.ok) throw new Error("bluesky_blob_upload_error: " + JSON.stringify(blobData));
    embed = { "$type": "app.bsky.embed.images", images: [{ alt: "", image: blobData.blob }] };
  }

  let text = content;
  if (text.length > 300) text = text.slice(0, 297) + "...";

  const record: Record<string, unknown> = {
    "$type": "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
  };
  if (embed) record.embed = embed;

  const postResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": `Bearer ${accessJwt}` },
    body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }),
  });
  const postData = await postResp.json();
  if (!postResp.ok) throw new Error("bluesky_post_error: " + JSON.stringify(postData));
  return postData.uri;
}

async function publishToLinkedIn(personUrn: string, token: string, content: string, imageUrl?: string) {
  const LI_VERSION = "202401";
  const baseHeaders = {
    "Authorization": `Bearer ${token}`,
    "LinkedIn-Version": LI_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };

  let mediaBlock: Record<string, unknown> | undefined;
  if (imageUrl) {
    const initResp = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } }),
    });
    const initData = await initResp.json();
    if (!initResp.ok || !initData.value) throw new Error("linkedin_image_init_error: " + JSON.stringify(initData));

    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error("linkedin_image_fetch_error: could not download image_url");
    const bytes = new Uint8Array(await imgResp.arrayBuffer());

    const uploadResp = await fetch(initData.value.uploadUrl, { method: "PUT", body: bytes });
    if (!uploadResp.ok) throw new Error("linkedin_image_upload_error: status " + uploadResp.status);

    mediaBlock = { media: { title: "", id: initData.value.image } };
  }

  const postBody: Record<string, unknown> = {
    author: personUrn,
    commentary: content,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (mediaBlock) postBody.content = mediaBlock;

  const postResp = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(postBody),
  });
  if (!postResp.ok) {
    const errBody = await postResp.text();
    throw new Error("linkedin_post_error: " + errBody);
  }
  return postResp.headers.get("x-restli-id") || "posted";
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
      const results: Record<string, any> = {};
      let brand: { name?: string; logo_url?: string } | null = null;
      if (accounts.some((a: any) => a.platform === "discord")) {
        const { data: cub } = await svc.from("cubicles").select("name, logo_url").eq("id", draft.cubicle_id).eq("user_id", draft.user_id).maybeSingle();
        brand = cub || null;
      }

      if (!accounts || accounts.length === 0) {
        await svc.from("drafts").update({ publish_error: "no_connected_accounts" }).eq("id", draft.id);
        summary.push({ draft_id: draft.id, error: "no_connected_accounts" });
        continue;
      }

      for (const acct of accounts) {
        try {
          if (acct.platform === "facebook") {
            results.facebook = { ok: true, post_id: await publishToFacebook(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
          } else if (acct.platform === "instagram") {
            results.instagram = { ok: true, post_id: await publishToInstagram(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
          } else if (acct.platform === "bluesky") {
            results.bluesky = { ok: true, post_id: await publishToBluesky(acct.external_account_name, acct.access_token, draft.content, draft.image_url) };
          } else if (acct.platform === "linkedin") {
            results.linkedin = { ok: true, post_id: await publishToLinkedIn(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
          } else if (acct.platform === "tiktok") {
            const r = await publishToTikTokFull(svc, acct, draft);
            results.tiktok = { ok: true, post_id: r.publish_id, status: r.status, note: r.note };
          } else if (acct.platform === "discord") {
            const r = await publishToDiscord(acct.access_token, {
              content: draft.content,
              imageUrls: collectDiscordImages(draft),
              videoUrl: draft.video_url,
              username: brand?.name,
              avatarUrl: brand?.logo_url,
            });
            results.discord = { ok: true, post_id: r.post_id, message_ids: r.message_ids, note: r.note };
          }
        } catch (e) {
          results[acct.platform] = { ok: false, error: String(e) };
        }
      }

      const anySucceeded = Object.values(results).some((r: any) => r.ok);
      const allErrors = Object.entries(results).filter(([, r]: any) => !r.ok).map(([p, r]: any) => `${p}: ${r.error}`).join(" | ");
      const firstPostId = results.facebook?.post_id || results.instagram?.post_id || results.bluesky?.post_id || results.linkedin?.post_id || results.tiktok?.post_id || results.discord?.post_id || null;

      await svc.from("drafts").update({
        status: anySucceeded ? "published" : draft.status,
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
