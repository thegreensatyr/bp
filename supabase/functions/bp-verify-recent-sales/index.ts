import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (_req: Request) => {
  return new Response(JSON.stringify({ ok: false, message: "decommissioned" }), { status: 410 });
});
