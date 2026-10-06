// Test-only helpers: synthetic media, a mock service-role client and a fetch router.
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

export const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CID = "a1111111-1111-4111-8111-111111111111";
export const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/secret.jpg";
export const P = (f: string) => `${UID}/${CID}/${f}`;

const enc = new TextEncoder();
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function cat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function box(type: string, payload: Uint8Array, large = false) {
  if (large) {
    const size = 16 + payload.length;
    const hdr = new Uint8Array(16); const dv = new DataView(hdr.buffer);
    dv.setUint32(0, 1); hdr.set(enc.encode(type), 4); dv.setBigUint64(8, BigInt(size));
    return cat(hdr, payload);
  }
  return cat(u32(8 + payload.length), enc.encode(type), payload);
}
/** Minimal ISO-BMFF file: ftyp + moov/mvhd (+ mdat), enough for duration parsing. */
export function fakeMp4(seconds: number, opts: { version?: 0 | 1; moovFirst?: boolean; timescale?: number; mdatBytes?: number; largeMdat?: boolean } = {}) {
  const ts = opts.timescale ?? 600, v = opts.version ?? 0;
  const ftyp = box("ftyp", cat(enc.encode("isom"), u32(512), enc.encode("isomiso2avc1mp41")));
  let mvhd: Uint8Array;
  if (v === 1) {
    const p = new Uint8Array(4 + 8 + 8 + 4 + 8 + 80); const dv = new DataView(p.buffer);
    p[0] = 1; dv.setUint32(20, ts); dv.setBigUint64(24, BigInt(Math.round(seconds * ts)));
    mvhd = box("mvhd", p);
  } else {
    const p = new Uint8Array(4 + 4 + 4 + 4 + 4 + 80); const dv = new DataView(p.buffer);
    dv.setUint32(12, ts); dv.setUint32(16, Math.round(seconds * ts));
    mvhd = box("mvhd", p);
  }
  const moov = box("moov", cat(box("free", new Uint8Array(4)), mvhd));
  const mdat = box("mdat", new Uint8Array(opts.mdatBytes ?? 256), opts.largeMdat);
  return opts.moovFirst === false ? cat(ftyp, mdat, moov) : cat(ftyp, moov, mdat);
}

export async function png(w: number, h: number, noise = false): Promise<Uint8Array> {
  const img = new Image(w, h);
  if (noise) { for (let i = 0; i < img.bitmap.length; i++) img.bitmap[i] = (i % 4 === 3) ? 255 : (Math.random() * 256) | 0; }
  else img.fill(0x9b7fc4ff);
  return await img.encode(1);
}
export async function jpeg(w: number, h: number, noise = false, q = 90): Promise<Uint8Array> {
  const img = new Image(w, h);
  if (noise) { for (let i = 0; i < img.bitmap.length; i++) img.bitmap[i] = (i % 4 === 3) ? 255 : (Math.random() * 256) | 0; }
  else img.fill(0x336699ff);
  return await img.encodeJPEG(q);
}

export type Call = { url: string; method: string; headers: Headers; body: any };
/** Installs a fetch mock. `routes` maps a substring/regex to a handler. Returns recorded calls + restore(). */
export function mockFetch(routes: Array<[string | RegExp, (c: Call) => Response | Promise<Response>]>) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const c: Call = { url, method: (init.method || "GET").toUpperCase(), headers: new Headers(init.headers || {}), body: init.body };
    calls.push(c);
    for (const [m, h] of routes) {
      if (typeof m === "string" ? url.includes(m) : m.test(url)) return await h(c);
    }
    return new Response(JSON.stringify({ error: "unmocked " + url }), { status: 599 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** Mock service-role client: storage (download/createSignedUrl/upload) + the bits of PostgREST the publishers touch. */
export function mockSvc(files: Record<string, Uint8Array>) {
  const uploads: Array<{ bucket: string; path: string; bytes: Uint8Array; opts: any }> = [];
  const signed: Array<{ bucket: string; path: string; ttl: number }> = [];
  const updates: any[] = [];
  return {
    uploads, signed, updates, files,
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          const b = files[`${bucket}/${path}`];
          return b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } };
        },
        createSignedUrl: async (path: string, ttl: number) => {
          signed.push({ bucket, path, ttl });
          return { data: { signedUrl: `https://sb.test/storage/v1/object/sign/${bucket}/${path}?token=T` }, error: null };
        },
        upload: async (path: string, bytes: Uint8Array, opts: any) => {
          uploads.push({ bucket, path, bytes, opts }); files[`${bucket}/${path}`] = bytes;
          return { error: null };
        },
      }),
    },
    from: (_table: string) => ({
      update: (u: any) => { updates.push(u); return { eq: async () => ({ error: null }) }; },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Satyr Coffee", logo_url: "https://x.test/logo.png" } }) }) }) }),
    }),
  };
}
