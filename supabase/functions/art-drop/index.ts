// Retired 2026-10-26 (site audit L1): the card-art upload tool is finished.
// Kept as an inert stub until it is deleted from the Supabase dashboard.
Deno.serve(() => new Response(JSON.stringify({ error: "gone", message: "This tool has been retired." }), { status: 410, headers: { "Content-Type": "application/json" } }));
