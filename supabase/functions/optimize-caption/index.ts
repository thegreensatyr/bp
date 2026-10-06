import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PLATFORM_LIMITS: Record<string, number> = {
  bluesky: 300,
  twitter: 280,
  x: 280,
  threads: 500,
  pinterest: 500,
  tiktok: 2200,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
};

function computeLimit(target_platforms: unknown, max_chars: unknown): number | null {
  if (typeof max_chars === "number" && isFinite(max_chars) && max_chars > 0) {
    return Math.floor(max_chars);
  }
  if (Array.isArray(target_platforms) && target_platforms.length) {
    const limits = target_platforms
      .map((p) => PLATFORM_LIMITS[String(p).toLowerCase()])
      .filter((n) => typeof n === "number");
    if (limits.length) return Math.min(...limits);
  }
  return null;
}

function trimToLimit(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const slice = t.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,;:.!?-]+$/, "").trim();
}

function buildSystemPrompt(
  brand_name: string,
  tone: string,
  audience: string,
  signature_phrases: string[],
  lexicon: string[],
  never_says: string[],
  limit: number | null,
  forbidden: string[] = [],
) {
  const limitClause = limit
    ? `\n\nHARD LIMIT: the rewritten caption must be ${limit} characters or fewer, counting every character including spaces, emoji, and punctuation — this is a real platform limit, not a suggestion. If the draft is too long, cut supporting detail, trim or drop a signature phrase, and shorten sentences, but keep the strongest hook and the core message intact. Do not truncate with "..." or an ellipsis — write a complete, natural-sounding caption that actually fits.`
    : "";
  const forbiddenClause = forbidden.length
    ? `\n\nOTHER BRANDS — FORBIDDEN: these names and terms belong to the creator's OTHER brands. Never use, mention, reference or allude to any of them, even if the draft contains them (remove them if it does): ${forbidden.join("; ")}. When you remove one, remove ONLY that mention: keep every other fact in the draft exactly (if the draft is about remixes, the caption is still about remixes), and do not fill the gap with any new activity, theme, project or detail.`
    : "";
  const factsClause = `\n\nNO NEW FACTS: only rephrase what the draft actually says. Do not invent or add any projects, collaborations, releases, events, people, places, dates, numbers, history or claims that are not explicitly in the draft. The lexicon and signature phrases are vocabulary to draw on only where they fit what the draft already says — never a reason to add new claims. If the draft is short, keep it short rather than padding it with made-up detail.`;

  return `You are a caption editor for a single brand voice inside a multi-brand content system called Brandparent. You ONLY rewrite captions for the brand "${brand_name}" and must never blend in language from any other brand.\n\nVoice profile for ${brand_name}:\n- Tone: ${tone || "(not set)"}\n- Audience: ${audience || "(not set)"}\n- Signature phrases this brand loves: ${signature_phrases.join(", ") || "(none set)"}\n- Words/phrases this brand owns (lean into these): ${lexicon.join(", ") || "(none set)"}\n- Words this brand NEVER says (do not use these under any circumstance): ${never_says.join(", ") || "(none set)"}\n\nRewrite the user's draft into a tighter, more polished caption in this exact voice. Keep it roughly the same length as the input unless it's very short.${limitClause} Do not add hashtags unless the draft already has some. Output ONLY the rewritten caption text, nothing else — no preamble, no quotes, no explanation.${forbiddenClause}${factsClause}`;
}

const ANTHROPIC_WORKSPACE_ID = "wrkspc_01Fh9wbiwS4aY3ZvNdqM9FrY";

async function callAnthropic(apiKey: string, systemPrompt: string, draft: string) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID,
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: draft }],
    }),
  });
  if (!resp.ok) throw new Error("anthropic_error: " + (await resp.text()));
  const data = await resp.json();
  return { caption: (data.content || []).map((b: any) => b.text || "").join("").trim(), provider: "claude" };
}

async function callGemini(apiKey: string, systemPrompt: string, draft: string) {
  const model = "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: draft }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.7 },
    }),
  });
  if (!resp.ok) throw new Error("gemini_error: " + (await resp.text()));
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const caption = parts.map((p: any) => p.text || "").join("").trim();
  return { caption, provider: "gemini" };
}

async function callProvider(anthropicKey: string | undefined, geminiKey: string | undefined, systemPrompt: string, draft: string) {
  if (anthropicKey) {
    try {
      return await callAnthropic(anthropicKey, systemPrompt, draft);
    } catch (anthropicErr) {
      console.error(JSON.stringify({
        diagnostic: "anthropic_call_failed",
        message: String(anthropicErr),
        key_present: true,
        key_len: anthropicKey.length,
        key_prefix: anthropicKey.slice(0, 12),
      }));
      if (geminiKey) {
        return await callGemini(geminiKey, systemPrompt, draft);
      }
      throw anthropicErr;
    }
  }
  console.error(JSON.stringify({ diagnostic: "no_anthropic_key_using_gemini" }));
  return await callGemini(geminiKey!, systemPrompt, draft);
}

function cleanTerm(t: unknown): string {
  return String(t || "").trim().replace(/^[\s"'“”‘’]+/, "").replace(/[\s"'“”‘’,.;:!?]+$/, "");
}

// Loads every OTHER cubicle belonging to the calling user (RLS-scoped via their JWT)
// and returns their names, lexicon and signature phrases as forbidden terms.
async function loadForbiddenTerms(authHeader: string, brand_name: string, ownTerms: string[]): Promise<string[]> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const pubRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const anon = pubRaw ? JSON.parse(pubRaw).default : Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon || !authHeader) return [];
    const client = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data, error } = await client.from("cubicles").select("name, lexicon, signature_phrases");
    if (error || !data) {
      console.error(JSON.stringify({ diagnostic: "forbidden_terms_query_failed", message: String(error?.message || "no data") }));
      return [];
    }
    const self = cleanTerm(brand_name).toLowerCase();
    const own = new Set(ownTerms.map((t) => cleanTerm(t).toLowerCase()).filter(Boolean));
    own.add(self);
    const out = new Map<string, string>();
    for (const c of data as any[]) {
      if (cleanTerm(c.name).toLowerCase() === self) continue;
      const terms = [c.name, ...(Array.isArray(c.lexicon) ? c.lexicon : []), ...(Array.isArray(c.signature_phrases) ? c.signature_phrases : [])];
      for (const t of terms) {
        const ct = cleanTerm(t);
        const key = ct.toLowerCase();
        if (ct.length < 3 || own.has(key)) continue;
        out.set(key, ct);
      }
    }
    return [...out.values()];
  } catch (e) {
    console.error(JSON.stringify({ diagnostic: "forbidden_terms_load_failed", message: String(e) }));
    return [];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word / whole-phrase, case-insensitive match; whitespace inside a phrase can vary.
function findLeaks(text: string, terms: string[]): string[] {
  const hay = text.replace(/[’‘]/g, "'");
  const hits: string[] = [];
  for (const t of terms) {
    const pattern = escapeRegex(t.replace(/[’‘]/g, "'")).replace(/\s+/g, "\\s+");
    try {
      if (new RegExp("(^|[^A-Za-z0-9])" + pattern + "(?=[^A-Za-z0-9]|$)", "i").test(hay)) hits.push(t);
    } catch {
      // skip a term that can't form a valid pattern
    }
  }
  return hits;
}

// How many corrective rewrites to attempt when the output still mentions another brand.
const MAX_LEAK_FIXES = 2;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");

    if (!anthropicKey && !geminiKey) {
      return new Response(
        JSON.stringify({ error: "not_configured", message: "No AI provider secret is set on this project yet (ANTHROPIC_API_KEY or GEMINI_API_KEY)." }),
        { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const {
      draft = "",
      tone = "",
      audience = "",
      signature_phrases = [],
      lexicon = [],
      never_says = [],
      brand_name = "this brand",
      target_platforms = [],
      max_chars,
    } = body;

    if (!draft.trim()) {
      return new Response(JSON.stringify({ error: "empty_draft" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const limit = computeLimit(target_platforms, max_chars);
    const forbidden = await loadForbiddenTerms(
      req.headers.get("Authorization") || "",
      brand_name,
      [...(Array.isArray(lexicon) ? lexicon : []), ...(Array.isArray(signature_phrases) ? signature_phrases : [])],
    );
    const systemPrompt = buildSystemPrompt(brand_name, tone, audience, signature_phrases, lexicon, never_says, limit, forbidden);

    let result = await callProvider(anthropicKey, geminiKey, systemPrompt, draft);
    let trimmed = false;

    if (limit && result.caption.length > limit) {
      const retryPrompt = `${systemPrompt}\n\nYour previous attempt was ${result.caption.length} characters — ${result.caption.length - limit} over the ${limit}-character limit. Cut it down further. Return ONLY the corrected caption, still ${limit} characters or fewer.`;
      try {
        const retryResult = await callProvider(anthropicKey, geminiKey, retryPrompt, result.caption);
        result = { caption: retryResult.caption, provider: retryResult.provider };
      } catch {
        // fall through to the hard trim below using the first attempt
      }
    }

    if (limit && result.caption.length > limit) {
      result = { caption: trimToLimit(result.caption, limit), provider: result.provider };
      trimmed = true;
    }

    // Cross-brand guard: re-check the output against every other brand's terms.
    // Up to MAX_LEAK_FIXES corrective rewrites; any leak still left is returned in `leaks`
    // so the app can warn the user instead of silently handing it over.
    let leaks = findLeaks(result.caption, forbidden);
    let fixAttempts = 0;
    while (leaks.length && fixAttempts < MAX_LEAK_FIXES) {
      fixAttempts++;
      const fixPrompt = `${systemPrompt}\n\nYour previous attempt used terms that belong to the creator's OTHER brands: ${leaks.join("; ")}. Rewrite it with every one of those removed and nothing invented to replace them — keep every other fact from the original draft, and if a sentence only exists to mention them, drop that sentence. Return ONLY the corrected caption${limit ? `, ${limit} characters or fewer` : ""}.`;
      try {
        const fixed = await callProvider(anthropicKey, geminiKey, fixPrompt, result.caption);
        let cap = fixed.caption;
        if (limit && cap.length > limit) { cap = trimToLimit(cap, limit); trimmed = true; }
        if (cap) result = { caption: cap, provider: fixed.provider };
      } catch {
        break; // keep the previous attempt; leaks are reported below
      }
      leaks = findLeaks(result.caption, forbidden);
    }
    if (leaks.length) {
      console.error(JSON.stringify({ diagnostic: "cross_brand_leak_unresolved", brand: brand_name, leaks, fixAttempts }));
    }

    return new Response(
      JSON.stringify({ caption: result.caption, provider: result.provider, char_count: result.caption.length, limit, trimmed, leaks }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(JSON.stringify({ diagnostic: "optimize_caption_error", message: String(e) }));
    return new Response(JSON.stringify({ error: "server_error", message: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
