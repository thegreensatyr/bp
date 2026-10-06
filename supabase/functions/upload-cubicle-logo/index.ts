import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// upload-cubicle-logo (v2, 2026-09-22)
// Handles BOTH per-cubicle brand images, server-side with the service role:
//   kind = "logo"       (default, backward compatible) -> cubicles.logo_url
//   kind = "background" (new)                          -> cubicles.background_image_url
// POST multipart {cubicle_id, file, kind?} uploads; DELETE json {cubicle_id, kind?} removes.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

const KINDS: Record<string, { suffix: string; column: string; maxBytes: number; types: string[] }> = {
  logo: {
    suffix: "logo",
    column: "logo_url",
    maxBytes: 5 * 1024 * 1024,
    types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  },
  background: {
    suffix: "bg",
    column: "background_image_url",
    maxBytes: 5 * 1024 * 1024,
    types: ["image/png", "image/jpeg", "image/webp"],
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const keysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = keysRaw ? JSON.parse(keysRaw).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

function getUserClient(authHeader: string) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const pubRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const anonKey = pubRaw ? JSON.parse(pubRaw).default : Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = getUserClient(authHeader);
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return json({ error: "unauthorized", message: "Your session has expired — please log in again." }, 401);
    }

    const svc = getServiceClient();

    let cubicleId = "";
    let kindKey = "logo";
    let file: File | null = null;

    if (req.method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      cubicleId = String(body.cubicle_id || "");
      kindKey = String(body.kind || "logo");
    } else if (req.method === "POST") {
      const form = await req.formData();
      cubicleId = String(form.get("cubicle_id") || "");
      kindKey = String(form.get("kind") || "logo");
      file = form.get("file") as File | null;
    } else {
      return json({ error: "method_not_allowed" }, 405);
    }

    const kind = KINDS[kindKey];
    if (!kind) return json({ error: "bad_kind", message: "Unknown image type." }, 400);
    if (!cubicleId) return json({ error: "missing_cubicle_id", message: "No cubicle selected." }, 400);

    const { data: cubicle, error: cubErr } = await svc.from("cubicles")
      .select("id,user_id").eq("id", cubicleId).eq("user_id", user.id).single();
    if (cubErr || !cubicle) {
      return json({ error: "not_found", message: "That cubicle wasn't found on your account." }, 404);
    }

    const path = `${user.id}/${cubicleId}-${kind.suffix}`;

    if (req.method === "DELETE") {
      await svc.storage.from("cubicle-logos").remove([path]);
      const { error: updErr } = await svc.from("cubicles").update({ [kind.column]: null }).eq("id", cubicleId);
      if (updErr) return json({ error: "db_failed", message: updErr.message }, 500);
      return json({ ok: true });
    }

    if (!file) return json({ error: "missing_file", message: "No file was received." }, 400);
    if (!kind.types.includes(file.type)) {
      const allowed = kindKey === "logo" ? "PNG, JPG, WEBP, or SVG" : "PNG, JPG, or WEBP";
      return json({ error: "bad_type", message: `Image must be ${allowed}.` }, 400);
    }
    if (file.size > kind.maxBytes) {
      return json({ error: "too_large", message: "Image must be under 5MB." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: upErr } = await svc.storage.from("cubicle-logos").upload(path, bytes, {
      upsert: true,
      contentType: file.type,
    });
    if (upErr) return json({ error: "upload_failed", message: String(upErr.message || upErr) }, 500);

    const { data: pub } = svc.storage.from("cubicle-logos").getPublicUrl(path);
    const publicUrl = `${pub.publicUrl}?t=${Date.now()}`;

    const { error: updErr } = await svc.from("cubicles").update({ [kind.column]: publicUrl }).eq("id", cubicleId);
    if (updErr) return json({ error: "db_failed", message: updErr.message }, 500);

    return json({ ok: true, url: publicUrl, kind: kindKey });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
});
