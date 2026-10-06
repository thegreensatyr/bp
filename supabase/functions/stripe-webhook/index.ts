// Supabase Edge Function: stripe-webhook
// Receives events directly FROM Stripe (not from the app), so verify_jwt must be false
// for this function — Stripe can't send a Supabase auth token, it authenticates
// via the signature on the payload instead.
//
// Requires Edge Function secrets (set manually in the Supabase dashboard):
//   STRIPE_SECRET_KEY       -> same test-mode secret key used by create-checkout-session
//   STRIPE_WEBHOOK_SECRET   -> the signing secret for THIS endpoint specifically,
//                              generated when the webhook endpoint is added in the
//                              Stripe dashboard (Developers > Webhooks > Add endpoint).
//                              Do not reuse the API secret key for this value.
//   COMPOSIO_API_KEY        -> Composio project API key. Already set. Used only to send
//                              a real-time Slack alert on a completed sale — never used
//                              for anything that touches money or the profiles table.
//   SLACK_ALERT_CHANNEL     -> optional. Slack channel name (e.g. "#sales-alerts") or
//                              channel ID to post the sale alert to. Defaults to
//                              "#sales-alerts" if not set.
//
// The Composio/Slack alert is 100% best-effort: it runs in its own try/catch, after
// the Supabase profile update, and can never fail the webhook or block a real sale
// from being recorded. If Slack isn't connected in Composio yet, or the call fails,
// this function logs it and moves on — Stripe still gets a 200 and the sale is safe.

import Stripe from "npm:stripe@17.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const COMPOSIO_BASE_URL = "https://backend.composio.dev";

async function sendSlackSaleAlert(params: {
  tier: string | undefined;
  amountTotal: number | null;
  currency: string | null;
  email: string | undefined;
}) {
  const composioKey = Deno.env.get("COMPOSIO_API_KEY");
  if (!composioKey) {
    console.log("Composio: COMPOSIO_API_KEY not set yet, skipping Slack alert.");
    return;
  }

  const slackChannel = Deno.env.get("SLACK_ALERT_CHANNEL") ?? "#sales-alerts";

  // Look up the active Slack connection Dustin authorized in the Composio dashboard.
  // No connected_account_id needs to be hardcoded — this finds it live every time,
  // so nothing breaks if the connection is ever reconnected or recreated.
  const acctRes = await fetch(
    `${COMPOSIO_BASE_URL}/api/v3.1/connected_accounts?toolkit_slugs=slack&statuses=ACTIVE`,
    { headers: { "x-api-key": composioKey } },
  );

  if (!acctRes.ok) {
    console.error("Composio: connected_accounts lookup failed:", acctRes.status, await acctRes.text());
    return;
  }

  const acctData = await acctRes.json();
  const connectedAccountId = acctData?.items?.[0]?.id;

  if (!connectedAccountId) {
    console.log("Composio: no active Slack connection found yet, skipping Slack alert.");
    return;
  }

  const amount = params.amountTotal != null ? (params.amountTotal / 100).toFixed(2) : "?";
  const currency = (params.currency ?? "usd").toUpperCase();
  const email = params.email ?? "unknown email";
  const tierLabel = params.tier ?? "unknown tier";

  const text =
    `:moneybag: *New BrandParent sale* — ${tierLabel} — $${amount} ${currency} — ${email}`;

  const sendRes = await fetch(`${COMPOSIO_BASE_URL}/api/v3.1/tools/execute/SLACK_SEND_MESSAGE`, {
    method: "POST",
    headers: {
      "x-api-key": composioKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      arguments: {
        channel: slackChannel,
        markdown_text: text,
      },
    }),
  });

  if (!sendRes.ok) {
    console.error("Composio: SLACK_SEND_MESSAGE failed:", sendRes.status, await sendRes.text());
  }
}

Deno.serve(async (req) => {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!stripeSecretKey || !webhookSecret) {
    console.error("Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET secret.");
    return new Response("Server not configured", { status: 500 });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" });
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(`Webhook signature verification failed`, { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? session.metadata?.user_id;
        const tier = session.metadata?.tier;
        if (!userId || !tier) break;

        await supabase
          .from("profiles")
          .update({
            subscription_tier: tier,
            subscription_status: tier === "studio" ? "trialing" : "active",
            stripe_customer_id: session.customer as string,
            stripe_subscription_id:
              tier === "studio" ? (session.subscription as string) : null,
            paid_at: new Date().toISOString(),
          })
          .eq("id", userId);

        // Best-effort real-time Slack alert. Never let this affect the response below.
        try {
          await sendSlackSaleAlert({
            tier,
            amountTotal: session.amount_total ?? null,
            currency: session.currency ?? null,
            email: session.customer_details?.email ?? undefined,
          });
        } catch (err) {
          console.error("Composio Slack alert failed (non-fatal):", err);
        }

        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        const statusMap: Record<string, string> = {
          trialing: "trialing",
          active: "active",
          past_due: "past_due",
          canceled: "canceled",
          unpaid: "past_due",
          incomplete_expired: "canceled",
        };

        await supabase
          .from("profiles")
          .update({
            subscription_status: statusMap[sub.status] ?? "inactive",
          })
          .eq("id", userId);
        break;
      }

      default:
        // Not an event we act on — acknowledge and move on.
        break;
    }
  } catch (err) {
    console.error("Error handling webhook event:", err);
    return new Response("Error processing webhook", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
