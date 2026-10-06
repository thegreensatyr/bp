// Supabase Edge Function: create-checkout-session
// Called from the signed-in app (signup.html / app.html) once a user picks a tier.
// Requires two Edge Function secrets to already exist (set manually in the
// Supabase dashboard — Project Settings > Edge Functions > Secrets):
//   STRIPE_SECRET_KEY      -> should now be the LIVE secret key (sk_live_...)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are already injected automatically by Supabase.

import Stripe from "npm:stripe@17.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 2026-09-08: both tiers now on real LIVE-mode prices.
// founding_member -> price_1UCaxPFgUjRxKtHkOdFIqXaq ($97 one-time)
// studio           -> price_1UCbtYFgUjRxKtHkgQL8KRNc ($27/mo recurring)
// (2026-09-14: briefly swapped founding_member to a $3 test price to try a
// cheap real-money test, then reverted before any charge was made once it
// turned out Dustin had no funds available to test with — back to the real
// $97 price here, unchanged from before that detour.)
// 2026-09-18: promo codes disabled at checkout (allow_promotion_codes -> false).
// BPTESTER100 (100% off) was still exposed on the live checkout's promo-code
// field — this fully blocks any code from being applied, without needing to
// touch/delete the coupon object in Stripe itself.
const PRICE_IDS: Record<string, string> = {
  founding_member: "price_1UCaxPFgUjRxKtHkOdFIqXaq", // $97 one-time, LIVE mode
  studio: "price_1UCbtYFgUjRxKtHkgQL8KRNc",          // $27/mo recurring, LIVE mode
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY secret is not set on this project yet." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { tier } = await req.json();
    if (tier !== "founding_member" && tier !== "studio") {
      return new Response(JSON.stringify({ error: "tier must be 'founding_member' or 'studio'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Identify the calling user from their Supabase auth JWT.
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not authenticated." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" });

    const origin = req.headers.get("origin") ?? "https://brandparent.app";

    const session = await stripe.checkout.sessions.create({
      mode: tier === "founding_member" ? "payment" : "subscription",
      line_items: [{ price: PRICE_IDS[tier], quantity: 1 }],
      customer_email: user.email ?? undefined,
      client_reference_id: user.id,
      metadata: { user_id: user.id, tier },
      allow_promotion_codes: false,
      // One-time "payment" mode does not create a Stripe Customer object by default —
      // force it so stripe_customer_id in profiles is always populated (needed for
      // support lookups/refunds), matching subscription mode's default behavior.
      customer_creation: tier === "founding_member" ? "always" : undefined,
      subscription_data:
        tier === "studio"
          ? { trial_period_days: 14, metadata: { user_id: user.id, tier } }
          : undefined,
      payment_intent_data:
        tier === "founding_member" ? { metadata: { user_id: user.id, tier } } : undefined,
      success_url: `${origin}/app.html?checkout=success`,
      cancel_url: `${origin}/signup.html?checkout=cancelled`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
