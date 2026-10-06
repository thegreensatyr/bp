import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { publishToTikTokFull } from "./tiktok.ts";

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
    throw new Error("instagram_needs_image: Instagram requires an image or video with every post — add an image URL to this draft first.");
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

function blueskyPostUrl(handle: string, uri: string): string {
  const rkey = uri.split("/").pop();
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

async function blueskyCreateSession(handle: string, appPassword: string) {
  const sessionResp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  const session = await sessionResp.json();
  if (!sessionResp.ok) throw new Error("bluesky_auth_error: " + JSON.stringify(session));
  return session as { accessJwt: string; did: string; handle: string; didDoc?: { service?: Array<{ id: string; serviceEndpoint: string }> } };
}

async function publishToBluesky(handle: string, appPassword: string, content: string, imageUrl?: string) {
  const { accessJwt, did } = await blueskyCreateSession(handle, appPassword);

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
  return { uri: postData.uri, url: blueskyPostUrl(handle, postData.uri) };
}

async function publishToBlueskyVideo(handle: string, appPassword: string, content: string, videoUrl: string) {
  const session = await blueskyCreateSession(handle, appPassword);
  const { accessJwt, did } = session;

  const pdsEndpoint = session.didDoc?.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
  const pdsHost = pdsEndpoint ? new URL(pdsEndpoint).hostname : "bsky.social";
  const aud = `did:web:${pdsHost}`;

  const authUrl = `https://bsky.social/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=com.atproto.repo.uploadBlob`;
  const authResp = await fetch(authUrl, { headers: { "Authorization": `Bearer ${accessJwt}` } });
  const authData = await authResp.json();
  if (!authResp.ok || !authData.token) {
    throw new Error("bluesky_video_serviceauth_error: " + JSON.stringify(authData));
  }
  const serviceToken = authData.token as string;

  const videoResp = await fetch(videoUrl);
  if (!videoResp.ok) throw new Error("bluesky_video_fetch_error: could not download video_url");
  const contentType = videoResp.headers.get("content-type") || "video/mp4";
  const bytes = new Uint8Array(await videoResp.arrayBuffer());
  if (bytes.byteLength > 100_000_000) {
    throw new Error("bluesky_video_too_large: video exceeds ~100MB — compress or trim it first");
  }

  const filename = (() => {
    try { return decodeURIComponent(new URL(videoUrl).pathname.split("/").pop() || "video.mp4"); }
    catch { return "video.mp4"; }
  })();

  const uploadUrl = `https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(did)}&name=${encodeURIComponent(filename)}`;
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": contentType, "Authorization": `Bearer ${serviceToken}` },
    body: bytes,
  });
  const uploadData = await uploadResp.json();
  if (!uploadResp.ok) throw new Error("bluesky_video_upload_error: " + JSON.stringify(uploadData));

  let jobId = uploadData.jobId as string | undefined;
  let blob = uploadData.blob;

  if (!blob && jobId) {
    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const statusResp = await fetch(`https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(jobId)}`, {
        headers: { "Authorization": `Bearer ${serviceToken}` },
      });
      const statusData = await statusResp.json();
      if (!statusResp.ok) throw new Error("bluesky_video_jobstatus_error: " + JSON.stringify(statusData));
      const state = statusData.jobStatus?.state;
      if (state === "JOB_STATE_COMPLETED") {
        blob = statusData.jobStatus?.blob;
        break;
      }
      if (state === "JOB_STATE_FAILED") {
        throw new Error("bluesky_video_processing_failed: " + JSON.stringify(statusData.jobStatus));
      }
    }
  }

  if (!blob) {
    throw new Error("bluesky_video_timeout: video was still processing after ~30s — it may still complete; check the account's Bluesky video status manually before retrying");
  }

  let text = content;
  if (text.length > 300) text = text.slice(0, 297) + "...";

  const record: Record<string, unknown> = {
    "$type": "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    embed: { "$type": "app.bsky.embed.video", video: blob, alt: "" },
  };

  const postResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": `Bearer ${accessJwt}` },
    body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }),
  });
  const postData = await postResp.json();
  if (!postResp.ok) throw new Error("bluesky_post_error: " + JSON.stringify(postData));
  return { uri: postData.uri, url: blueskyPostUrl(handle, postData.uri) };
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

// New: Pinterest. board_id was captured (from the account's first board) when
// the account was connected in pinterest-oauth-callback and stored as
// external_account_id on the social_accounts row.
async function publishToPinterest(boardId: string, token: string, content: string, imageUrl?: string) {
  if (!imageUrl) {
    throw new Error("pinterest_needs_image: Pinterest requires an image with every pin — add an image URL to this draft first.");
  }
  if (!boardId) {
    throw new Error("pinterest_no_board: no board was found on this Pinterest account when it was connected — create a board on Pinterest, then disconnect and reconnect here.");
  }
  const resp = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      board_id: boardId,
      title: content.slice(0, 100),
      description: content,
      media_source: { source_type: "image_url", url: imageUrl },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("pinterest_pin_error: " + JSON.stringify(data));
  return data.id || "posted";
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

    const { data: allAccounts } = await svc.from("social_accounts").select("*").eq("cubicle_id", draft.cubicle_id);
    const accounts = (draft.target_platforms && draft.target_platforms.length)
      ? (allAccounts || []).filter((a: any) => draft.target_platforms.includes(a.platform))
      : (allAccounts || []);

    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ error: "no_connected_accounts" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const results: Record<string, any> = {};
    for (const acct of accounts) {
      try {
        if (acct.platform === "facebook") {
          results.facebook = { ok: true, post_id: await publishToFacebook(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
        } else if (acct.platform === "instagram") {
          results.instagram = { ok: true, post_id: await publishToInstagram(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
        } else if (acct.platform === "bluesky") {
          if (draft.video_url) {
            const r = await publishToBlueskyVideo(acct.external_account_name, acct.access_token, draft.content, draft.video_url);
            results.bluesky = { ok: true, post_id: r.uri, post_url: r.url };
          } else {
            const r = await publishToBluesky(acct.external_account_name, acct.access_token, draft.content, draft.image_url);
            results.bluesky = { ok: true, post_id: r.uri, post_url: r.url };
          }
        } else if (acct.platform === "linkedin") {
          results.linkedin = { ok: true, post_id: await publishToLinkedIn(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
        } else if (acct.platform === "tiktok") {
          const r = await publishToTikTokFull(svc, acct, draft);
          results.tiktok = { ok: true, post_id: r.publish_id, status: r.status, note: r.note };
        } else if (acct.platform === "pinterest") {
          results.pinterest = { ok: true, post_id: await publishToPinterest(acct.external_account_id, acct.access_token, draft.content, draft.image_url) };
        }
      } catch (e) {
        results[acct.platform] = { ok: false, error: String(e) };
      }
    }

    const anySucceeded = Object.values(results).some((r: any) => r.ok);
    const allErrors = Object.entries(results).filter(([, r]: any) => !r.ok).map(([p, r]: any) => `${p}: ${r.error}`).join(" | ");
    const firstPostId = results.facebook?.post_id || results.instagram?.post_id || results.bluesky?.post_id || results.linkedin?.post_id || results.tiktok?.post_id || results.pinterest?.post_id || null;

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
