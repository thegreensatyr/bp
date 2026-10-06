import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function buildSystemPrompt(
  brand_name: string,
  tone: string,
  audience: string,
  signature_phrases: string[],
  lexicon: string[],
  never_says: string[],
  targetCount: number,
  minSec: number,
  maxSec: number,
) {
  return `You select highlight-worthy clip segments from a video transcript for the brand "${brand_name}" inside a multi-brand content system called Brandparent. You ONLY write in this brand's voice and must never blend in language from any other brand.

Voice profile for ${brand_name}:
- Tone: ${tone || "(not set)"}
- Audience: ${audience || "(not set)"}
- Signature phrases this brand loves: ${signature_phrases.join(", ") || "(none set)"}
- Words/phrases this brand owns (lean into these): ${lexicon.join(", ") || "(none set)"}
- Words this brand NEVER says (do not use these under any circumstance): ${never_says.join(", ") || "(none set)"}

You will receive a timestamped transcript as a JSON array of {start, end, text} segments (seconds).

Pick up to ${targetCount} of the strongest, most self-contained highlight-worthy moments. Each selected clip must:
- Use only start/end timestamps that appear in (or fall between) the given segments — never invent a timestamp outside the transcript's range.
- Last between ${minSec} and ${maxSec} seconds.
- Make sense as a standalone short clip (a real hook or payoff, not a mid-sentence fragment).
- Not overlap with any other selected clip.

For each clip, write a short "reason" (why this moment is clip-worthy), a punchy "suggested_hook" (first line/on-screen text for the clip, in this brand's voice), and a "suggested_caption" (the social caption to post with it, in this brand's voice, respecting the never-says list).

Output ONLY a JSON object of this exact shape, nothing else — no markdown fences, no preamble, no explanation:
{"clips":[{"start":number,"end":number,"reason":"string","suggested_hook":"string","suggested_caption":"string"}]}`;
}

function transcriptToText(transcript: { start: number; end: number; text: string }[]) {
  return JSON.stringify(transcript);
}

function parseClipsResponse(raw: string) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.clips)) {
    throw new Error("malformed_response: expected { clips: [...] }");
  }
  return parsed.clips;
}

async function callAnthropic(apiKey: string, systemPrompt: string, transcriptJson: string) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: transcriptJson }],
    }),
  });
  if (!resp.ok) throw new Error("anthropic_error: " + (await resp.text()));
  const data = await resp.json();
  const raw = (data.content || []).map((b: any) => b.text || "").join("").trim();
  return { clips: parseClipsResponse(raw), provider: "claude" };
}

async function callGemini(apiKey: string, systemPrompt: string, transcriptJson: string) {
  const model = "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: transcriptJson }] }],
      generationConfig: { maxOutputTokens: 1500, temperature: 0.5 },
    }),
  });
  if (!resp.ok) throw new Error("gemini_error: " + (await resp.text()));
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const raw = parts.map((p: any) => p.text || "").join("").trim();
  return { clips: parseClipsResponse(raw), provider: "gemini" };
}

function validateClips(
  clips: any[],
  videoDuration: number,
  minSec: number,
  maxSec: number,
) {
  return clips
    .filter((c) => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start)
    .map((c) => ({
      ...c,
      start: Math.max(0, c.start),
      end: Math.min(videoDuration, c.end),
    }))
    .filter((c) => {
      const len = c.end - c.start;
      return len >= minSec * 0.8 && len <= maxSec * 1.2;
    });
}

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
        { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const {
      transcript = [],
      video_duration_seconds,
      target_clip_count = 3,
      min_clip_seconds = 15,
      max_clip_seconds = 60,
      brand_name = "this brand",
      tone = "",
      audience = "",
      signature_phrases = [],
      lexicon = [],
      never_says = [],
    } = body;

    if (!Array.isArray(transcript) || transcript.length === 0) {
      return new Response(JSON.stringify({ error: "empty_transcript" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (typeof video_duration_seconds !== "number" || video_duration_seconds <= 0) {
      return new Response(JSON.stringify({ error: "missing_video_duration_seconds" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = buildSystemPrompt(
      brand_name, tone, audience, signature_phrases, lexicon, never_says,
      target_clip_count, min_clip_seconds, max_clip_seconds,
    );
    const transcriptJson = transcriptToText(transcript);

    let result: { clips: any[]; provider: string };
    try {
      result = anthropicKey
        ? await callAnthropic(anthropicKey, systemPrompt, transcriptJson)
        : await callGemini(geminiKey!, systemPrompt, transcriptJson);
    } catch (providerErr) {
      if (anthropicKey && geminiKey) {
        result = await callGemini(geminiKey, systemPrompt, transcriptJson);
      } else {
        throw providerErr;
      }
    }

    const validClips = validateClips(result.clips, video_duration_seconds, min_clip_seconds, max_clip_seconds);

    return new Response(
      JSON.stringify({ clips: validClips, provider: result.provider, raw_clip_count: result.clips.length }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: "server_error", message: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
