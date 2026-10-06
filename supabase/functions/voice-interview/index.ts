import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Supabase Edge Function: voice-interview (v2, 2026-09-22)
// Powers the "Getting to know you" interview in app.html's Voice Profile tab.
// Fixes vs v1:
//  - Conversation is normalized before sending: it always starts with a user
//    turn and roles strictly alternate (v1 sent [assistant, user, ...] after the
//    first question, which Claude rejects -> silent Gemini fallback -> stalls).
//  - Reply budget raised so the final <PROFILE> JSON is never cut off.
//  - After enough answers the model is told to wrap up, so it always finishes.
//  - If the model forgets or mangles the PROFILE block on the final turn, one
//    repair call asks for the JSON only.
//  - Errors return a readable `message` the app can show.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

const WRAP_UP_AFTER = 5; // user answers before we require the profile
const HARD_CAP = 8; // absolute max user answers accepted
const ANTHROPIC_WORKSPACE_ID = "wrkspc_01Fh9wbiwS4aY3ZvNdqM9FrY"; // same as optimize-caption

type Msg = { role: "user" | "assistant"; content: string };

function systemPrompt(brandName: string, mustFinish: boolean): string {
  const base = `You are conducting a short, warm "getting to know you" interview to learn the voice of a brand called "${brandName}" inside a multi-brand content tool called Brandparent. The person you're interviewing owns this brand and wants to feel the tool truly understands it.

Ask ONE short, conversational question at a time. Across the conversation, cover:
- What makes this brand different from anything else they do or anything competitors do
- Who the audience is
- The tone/personality (playful, authoritative, warm, edgy, etc.)
- 2-4 signature phrases or expressions this brand loves to use
- Words or phrases this brand strongly identifies with (its lexicon)
- Words or phrases this brand should NEVER say (off-limits, off-brand, or belonging to a different brand of theirs)

Reference what they already told you. Never ask more than one question per message. Use their real words; don't invent facts about them.

When you have enough (usually after 4-5 answers), stop asking. Reply with one warm closing sentence, then on its own line a JSON block wrapped exactly like this:
<PROFILE>{"tone":"...","audience":"...","signature_phrases":["..."],"lexicon":["..."],"never_says":["..."]}</PROFILE>
Only include the PROFILE block once, at the end. Until then, no JSON.`;
  return mustFinish
    ? base + `\n\nIMPORTANT: You now have enough information. Do NOT ask another question. Write the closing sentence and the <PROFILE> block now, filling every field from what they said (use your best reasonable reading for anything they didn't cover).`
    : base;
}

// Always start with a user turn, merge consecutive same-role turns, drop empties.
function normalize(incoming: unknown[]): Msg[] {
  const clean: Msg[] = [];
  for (const m of incoming as any[]) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.trim().slice(0, 4000);
    if (!content) continue;
    const last = clean[clean.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + content;
    else clean.push({ role: m.role, content });
  }
  if (clean.length === 0 || clean[0].role !== "user") {
    clean.unshift({ role: "user", content: "Hi! I'm ready — ask me your first question." });
  }
  // Must end on a user turn for the model to reply.
  if (clean[clean.length - 1].role !== "user") {
    clean.push({ role: "user", content: "(continue)" });
  }
  return clean;
}

function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
  return String(v || "").trim();
}

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 25);
}

function extractProfile(text: string): { reply: string; profile: any | null } {
  const m = text.match(/<PROFILE>([\s\S]*?)<\/PROFILE>/i) || text.match(/(\{[\s\S]*"never_says"[\s\S]*\})/);
  if (!m) return { reply: text.trim(), profile: null };
  let jsonText = m[1].trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(jsonText);
    const profile = {
      tone: asText(parsed.tone),
      audience: asText(parsed.audience),
      signature_phrases: cleanList(parsed.signature_phrases),
      lexicon: cleanList(parsed.lexicon),
      never_says: cleanList(parsed.never_says),
    };
    const reply = text.replace(m[0], "").replace(/<\/?PROFILE>/gi, "").trim();
    return { reply: reply || "Got everything I need — take a look below.", profile };
  } catch {
    return { reply: text.replace(/<PROFILE>[\s\S]*$/i, "").trim(), profile: null };
  }
}

async function callAnthropic(apiKey: string, system: string, messages: Msg[], maxTokens: number) {
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID,
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!resp.ok) throw new Error("anthropic_error " + resp.status + ": " + (await resp.text()).slice(0, 400));
  const data = await resp.json();
  return (data.content || []).map((b: any) => b.text || "").join("").trim();
}

async function callGemini(apiKey: string, system: string, messages: Msg[], maxTokens: number) {
  const model = "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8 },
    }),
  });
  if (!resp.ok) throw new Error("gemini_error " + resp.status + ": " + (await resp.text()).slice(0, 400));
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p: any) => p.text || "").join("").trim();
}

async function callModel(
  keys: { anthropic?: string; gemini?: string },
  system: string,
  messages: Msg[],
  maxTokens: number,
): Promise<{ text: string; provider: string }> {
  const errors: string[] = [];
  if (keys.anthropic) {
    try {
      return { text: await callAnthropic(keys.anthropic, system, messages, maxTokens), provider: "claude" };
    } catch (e) {
      errors.push(String(e));
      console.error(JSON.stringify({ diagnostic: "voice_interview_anthropic_failed", message: String(e) }));
    }
  }
  if (keys.gemini) {
    try {
      return { text: await callGemini(keys.gemini, system, messages, maxTokens), provider: "gemini" };
    } catch (e) {
      errors.push(String(e));
      console.error(JSON.stringify({ diagnostic: "voice_interview_gemini_failed", message: String(e) }));
    }
  }
  throw new Error(errors.join(" | ") || "no provider available");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const keys = { anthropic: Deno.env.get("ANTHROPIC_API_KEY"), gemini: Deno.env.get("GEMINI_API_KEY") };
    if (!keys.anthropic && !keys.gemini) {
      return new Response(JSON.stringify({ error: "not_configured", message: "The interview's AI service isn't set up yet." }), {
        status: 503, headers: JSON_HEADERS,
      });
    }

    const body = await req.json().catch(() => ({}));
    const brandName = String(body.brand_name || "this brand").slice(0, 120);
    const messages = normalize(Array.isArray(body.messages) ? body.messages : []);
    const realUserAnswers = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => m && m.role === "user" && typeof m.content === "string" && m.content.trim()).length;

    if (realUserAnswers > HARD_CAP) {
      return new Response(JSON.stringify({ error: "too_long", message: "This interview ran long — hit Start over to try again." }), {
        status: 200, headers: JSON_HEADERS,
      });
    }

    const mustFinish = realUserAnswers >= WRAP_UP_AFTER;
    const first = await callModel(keys, systemPrompt(brandName, mustFinish), messages, 1200);
    let { reply, profile } = extractProfile(first.text);
    let provider = first.provider;

    // Repair: we required a profile but didn't get a usable one.
    if (mustFinish && !profile) {
      const repairSystem = `Return ONLY a JSON object (no prose, no code fences) with keys tone, audience, signature_phrases, lexicon, never_says, describing the brand "${brandName}" based on the interview transcript the user provides. Arrays of short strings.`;
      const transcript = messages.map((m) => `${m.role === "user" ? "Brand owner" : "Interviewer"}: ${m.content}`).join("\n");
      try {
        const fix = await callModel(keys, repairSystem, [{ role: "user", content: transcript }], 800);
        const repaired = extractProfile(`<PROFILE>${fix.text.replace(/^```(?:json)?|```$/gim, "").trim()}</PROFILE>`);
        if (repaired.profile) {
          profile = repaired.profile;
          provider = fix.provider;
          if (!reply || /\?\s*$/.test(reply)) reply = "Thank you — I've got a clear picture of this brand's voice. Take a look below.";
        }
      } catch (e) {
        console.error(JSON.stringify({ diagnostic: "voice_interview_repair_failed", message: String(e) }));
      }
    }

    return new Response(JSON.stringify({ reply, profile, done: !!profile, provider }), { headers: JSON_HEADERS });
  } catch (e) {
    console.error(JSON.stringify({ diagnostic: "voice_interview_error", message: String(e) }));
    return new Response(JSON.stringify({
      error: "server_error",
      message: "The interview couldn't reach its AI service just now. Please try again in a moment.",
      detail: String(e).slice(0, 500),
    }), { status: 502, headers: JSON_HEADERS });
  }
});
