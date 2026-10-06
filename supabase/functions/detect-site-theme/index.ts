import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Supabase Edge Function: detect-site-theme (v2, 2026-09-22)
// "Detect theme from my site" in app.html's Cubicle theme card.
// v1 only understood #hex colors, threw away black/white/greys (so it could
// never find a background or text color), read only 2 stylesheets, and gave
// back an unsorted pile of chips. v2:
//  - understands #hex, rgb()/rgba(), hsl()/hsla(), CSS variables (var(--x)),
//  - reads up to 6 stylesheets (+ @import) and inline styles,
//  - figures out ROLES: background, text, headline (main accent), secondary,
//    heading font, body font — returned as a ready-to-apply `suggested` theme,
//  - still returns the raw top colors/fonts for hand-picking,
//  - never auto-saves anything, and always answers 200 with {ok:false, error}
//    for "site problems" so the app can show the real reason.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

const MAX_HTML_CHARS = 2_000_000;
const MAX_CSS_CHARS = 600_000;
const FETCH_TIMEOUT_MS = 9000;
const MAX_SHEETS = 6;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 BrandparentThemeBot/2.0";

const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "inherit", "initial", "unset", "revert", "-apple-system",
  "blinkmacsystemfont", "segoe ui", "helvetica neue", "helvetica", "arial", "roboto", "noto sans",
  "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji", "emoji", "math", "fangsong",
  "sfmono-regular", "menlo", "monaco", "consolas", "liberation mono", "courier new", "times new roman", "times",
  "georgia", "verdana", "tahoma", "ui-serif", "icons", "fontawesome", "font awesome 5 free", "font awesome 6 free",
  "dashicons", "swiper-icons", "star", "eicons",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------- URL safety ----------------
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0" || h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return h.includes(":");
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function normalizeUrl(raw: string): URL {
  let c = raw.trim();
  if (!/^https?:\/\//i.test(c)) c = "https://" + c;
  const u = new URL(c);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The address must start with http or https.");
  if (isPrivateHost(u.hostname)) throw new Error("That address isn't reachable from here.");
  return u;
}

async function fetchText(url: string, timeoutMs: number, cap: number): Promise<{ text: string; finalUrl: string }> {
  const u = new URL(url);
  if (isPrivateHost(u.hostname)) throw new Error("blocked host");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html,text/css,*/*;q=0.8" },
    });
    if (!resp.ok) throw new Error(`the site answered with error ${resp.status}`);
    const text = await resp.text();
    return { text: text.slice(0, cap), finalUrl: resp.url || url };
  } finally {
    clearTimeout(t);
  }
}

// ---------------- color parsing ----------------
type RGB = [number, number, number];

const NAMED: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
  navy: "#000080", teal: "#008080", purple: "#800080", maroon: "#800000", olive: "#808000",
  gold: "#ffd700", orange: "#ffa500", crimson: "#dc143c", indigo: "#4b0082", ivory: "#fffff0",
  beige: "#f5f5dc", silver: "#c0c0c0", gray: "#808080", grey: "#808080", whitesmoke: "#f5f5f5",
  darkgreen: "#006400", darkred: "#8b0000", darkblue: "#00008b", rebeccapurple: "#663399",
  darkslategray: "#2f4f4f", forestgreen: "#228b22", goldenrod: "#daa520", coral: "#ff7f50",
};

function clamp(n: number, lo = 0, hi = 255) { return Math.max(lo, Math.min(hi, n)); }
function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => clamp(Math.round(v)).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex: string): RGB | null {
  let h = hex.replace("#", "").trim();
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  else if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// Parse one CSS color token -> {hex, alpha} or null
function parseColor(tok: string): { hex: string; alpha: number } | null {
  const t = tok.trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("#")) {
    const rgb = hexToRgb(t);
    if (!rgb) return null;
    let alpha = 1;
    const raw = t.slice(1);
    if (raw.length === 8) alpha = parseInt(raw.slice(6, 8), 16) / 255;
    if (raw.length === 4) alpha = parseInt(raw[3] + raw[3], 16) / 255;
    return { hex: toHex(rgb), alpha };
  }
  let m = t.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,\/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const ch = (v: string) => (v.endsWith("%") ? (parseFloat(v) * 2.55) : parseFloat(v));
    const alpha = m[4] ? (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return { hex: toHex([ch(m[1]), ch(m[2]), ch(m[3])]), alpha };
  }
  m = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,\/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const alpha = m[4] ? (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return { hex: toHex(hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]))), alpha };
  }
  if (NAMED[t]) return { hex: NAMED[t], alpha: 1 };
  return null;
}

const COLOR_TOKEN_RE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

function satOf([r, g, b]: RGB) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
function isChromatic(hex: string) {
  const rgb = hexToRgb(hex)!;
  const max = Math.max(...rgb), min = Math.min(...rgb);
  return (max - min) >= 28 && satOf(rgb) > 0.18;
}
function lum(hex: string) {
  const rgb = hexToRgb(hex)!;
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function colorDist(a: string, b: string) {
  const x = hexToRgb(a)!, y = hexToRgb(b)!;
  const rm = (x[0] + y[0]) / 2;
  const dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

// ---------------- CSS model ----------------
type Decl = { selector: string; prop: string; value: string };

function stripComments(css: string) { return css.replace(/\/\*[\s\S]*?\*\//g, ""); }

// Flat rule parser — good enough for theme extraction (handles @media by
// descending into blocks; ignores @font-face/@keyframes bodies).
function parseDecls(css: string): Decl[] {
  const out: Decl[] = [];
  const src = stripComments(css);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    let selector = m[1].trim();
    // selector text may carry a leading "@media ... {" remnant; keep the last segment
    const atIdx = selector.lastIndexOf(";");
    if (atIdx >= 0) selector = selector.slice(atIdx + 1).trim();
    if (/^@(font-face|keyframes|-webkit-keyframes|page)/i.test(selector) || /^(from|to|\d+%)$/i.test(selector)) continue;
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      const prop = part.slice(0, i).trim().toLowerCase();
      const value = part.slice(i + 1).replace(/!important/i, "").trim();
      if (prop && value) out.push({ selector: selector.toLowerCase(), prop, value });
    }
  }
  return out;
}

function buildVarMap(decls: Decl[]): Map<string, string> {
  const vars = new Map<string, string>();
  // Prefer :root / html / body definitions, then first seen.
  const ranked = [...decls].filter((d) => d.prop.startsWith("--"))
    .sort((a, b) => rootScore(b.selector) - rootScore(a.selector));
  for (const d of ranked) if (!vars.has(d.prop)) vars.set(d.prop, d.value);
  return vars;
}
function rootScore(sel: string) {
  if (/(^|,)\s*:root\b/.test(sel)) return 3;
  if (/(^|,)\s*html\b/.test(sel)) return 2;
  if (/(^|,)\s*body\b/.test(sel)) return 1;
  return 0;
}

function resolveVars(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 6 || !value.includes("var(")) return value;
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_m, name, fallback) => {
    const v = vars.get(name);
    if (v !== undefined) return resolveVars(v, vars, depth + 1);
    return fallback ? resolveVars(fallback.trim(), vars, depth + 1) : "";
  });
  return out;
}

function colorsIn(value: string): { hex: string; alpha: number }[] {
  const res: { hex: string; alpha: number }[] = [];
  const toks = value.match(COLOR_TOKEN_RE) || [];
  for (const t of toks) { const c = parseColor(t); if (c) res.push(c); }
  if (!toks.length) {
    for (const w of value.toLowerCase().split(/[\s,]+/)) { if (NAMED[w]) res.push({ hex: NAMED[w], alpha: 1 }); }
  }
  return res;
}

function selectorWeight(sel: string): { root: boolean; heading: boolean; action: boolean } {
  const parts = sel.split(",").map((s) => s.trim());
  const root = parts.some((p) => /^(html|body|:root|main|#root|#app|\.site|\.wrapper|\.page|#page)$/.test(p));
  const heading = parts.some((p) => /(^|\s|>)h[1-3]\b|\.title|\.heading|\.hero|\.logo|\.brand/.test(p));
  const action = parts.some((p) => /\bbutton\b|\.btn|\.button|\ba\b(?![\w-])|\ba:|\.cta|\[type=.?submit/.test(p));
  return { root, heading, action };
}

// ---------------- extraction ----------------
function extractThemeColorMeta(html: string): string | null {
  const m = html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
  if (!m) return null;
  const c = parseColor(m[1]);
  return c ? c.hex : null;
}

function inlineCss(html: string): string {
  const blocks: string[] = [];
  let m;
  const styleTagRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleTagRe.exec(html))) blocks.push(m[1]);
  // style="" attributes: wrap as a pseudo rule, tagging body/html ones
  const attrRe = /<(body|html|header|nav|main|section|div|a|button|h1|h2|h3)\b[^>]*\sstyle=["']([^"']*)["']/gi;
  while ((m = attrRe.exec(html))) blocks.push(`${m[1].toLowerCase()}{${m[2]}}`);
  return blocks.join("\n");
}

async function linkedCss(html: string, baseUrl: string): Promise<{ css: string; fontLinks: string[] }> {
  const hrefs: string[] = [];
  const fontLinks: string[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    if (!/rel=["'][^"']*stylesheet/i.test(tag) && !/as=["']style["']/i.test(tag)) continue;
    const hm = tag.match(/href=["']([^"']+)["']/i);
    if (!hm) continue;
    const href = hm[1].replace(/&amp;/g, "&");
    if (/fonts\.googleapis\.com|use\.typekit\.net|fonts\.bunny\.net/i.test(href)) { fontLinks.push(href); continue; }
    if (/font-?awesome|bootstrap-icons|dashicons|swiper|slick|animate(\.min)?\.css|aos(\.min)?\.css/i.test(href)) continue;
    hrefs.push(href);
  }
  const chunks: string[] = [];
  const queue = hrefs.slice(0, MAX_SHEETS);
  let fetched = 0;
  while (queue.length && fetched < MAX_SHEETS + 2) {
    const href = queue.shift()!;
    fetched++;
    try {
      const resolved = new URL(href, baseUrl).toString();
      const { text } = await fetchText(resolved, 5000, MAX_CSS_CHARS);
      chunks.push(text);
      // follow @import once
      const imp = text.match(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi) || [];
      for (const i of imp.slice(0, 2)) {
        const u = i.replace(/@import\s+(?:url\()?["']?/i, "");
        if (/fonts\.googleapis\.com/i.test(u)) fontLinks.push(u);
        else queue.push(new URL(u, resolved).toString());
      }
    } catch { /* best effort */ }
  }
  return { css: chunks.join("\n"), fontLinks };
}

function googleFontNames(links: string[], html: string): string[] {
  const names: string[] = [];
  const all = [...links];
  const htmlLinks = html.match(/fonts\.googleapis\.com\/css2?\?[^"'\s)]+/gi) || [];
  all.push(...htmlLinks);
  for (const href of all) {
    const fams = href.replace(/&amp;/g, "&").match(/family=([^&"']+)/g) || [];
    for (const f of fams) {
      for (const part of f.replace("family=", "").split("|")) {
        const n = decodeURIComponent(part.split(":")[0]).replace(/\+/g, " ").trim();
        if (n && !names.includes(n)) names.push(n);
      }
    }
  }
  return names;
}

function firstFamily(value: string, vars: Map<string, string>): string | null {
  const v = resolveVars(value, vars);
  for (const raw of v.split(",")) {
    const name = raw.trim().replace(/^['"]|['"]$/g, "").trim();
    if (!name || name.startsWith("var(")) continue;
    if (GENERIC_FONTS.has(name.toLowerCase())) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9 \-]{1,40}$/.test(name)) continue;
    return name;
  }
  return null;
}

type Tally = Map<string, number>;
function bump(t: Tally, k: string, w: number) { t.set(k, (t.get(k) || 0) + w); }
function topN(t: Tally, n: number) { return [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }

function analyze(html: string, css: string, fontLinks: string[]) {
  const decls = parseDecls(css);
  const vars = buildVarMap(decls);

  const bg: Tally = new Map(), fg: Tally = new Map(), accent: Tally = new Map(), all: Tally = new Map();
  const headingFonts: Tally = new Map(), bodyFonts: Tally = new Map();

  const meta = extractThemeColorMeta(html);
  if (meta) { bump(all, meta, 20); if (isChromatic(meta)) bump(accent, meta, 30); }

  for (const d of decls) {
    const w = selectorWeight(d.selector);
    if (d.prop === "font-family" || d.prop === "font") {
      const fam = firstFamily(d.prop === "font" ? d.value.replace(/^.*?\d[\w.%]*(\/[\w.%]+)?\s+/, "") : d.value, vars);
      if (fam) {
        const isMono = /mono|code/i.test(fam);
        if (w.heading) bump(headingFonts, fam, isMono ? 1 : 5);
        if (w.root) bump(bodyFonts, fam, isMono ? 2 : 8);
        bump(bodyFonts, fam, isMono ? 0.2 : 1);
      }
      continue;
    }
    const isBgProp = d.prop === "background" || d.prop === "background-color";
    const isFgProp = d.prop === "color";
    const isAccentProp = isBgProp || isFgProp || d.prop.startsWith("border") || d.prop === "fill" || d.prop === "outline-color" || d.prop.startsWith("--");
    if (!isBgProp && !isFgProp && !isAccentProp) continue;

    // custom properties: font variables name their role directly
    if (d.prop.startsWith("--") && /font|family|typeface/.test(d.prop)) {
      const fam = firstFamily(d.value, vars);
      if (fam) {
        const isMono = /mono|code/i.test(d.prop) || /mono/i.test(fam);
        if (/display|heading|head|title|hero|brand|serif/.test(d.prop) && !isMono) bump(headingFonts, fam, 10);
        if (/body|base|text|sans|copy|primary|main/.test(d.prop) && !isMono) bump(bodyFonts, fam, 10);
      }
      continue;
    }
    // custom properties with brand-ish names are strong accent hints
    if (d.prop.startsWith("--")) {
      const cs = colorsIn(d.value);
      for (const c of cs) {
        if (c.alpha < 0.5) continue;
        const named = /primary|brand|accent|main|theme|highlight|link|secondary/.test(d.prop);
        bump(all, c.hex, named ? 4 : 1);
        if (named && isChromatic(c.hex)) bump(accent, c.hex, /secondary/.test(d.prop) ? 4 : 8);
        if (/(^|-)(bg|background|base|surface|body)(-|$)/.test(d.prop)) bump(bg, c.hex, rootScore(d.selector) ? 6 : 2);
        if (/(^|-)(text|fg|foreground|ink|body-color|font-color)(-|$)/.test(d.prop)) bump(fg, c.hex, rootScore(d.selector) ? 6 : 2);
      }
      continue;
    }

    const value = resolveVars(d.value, vars);
    if (/gradient|url\(/i.test(value) && !/#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i.test(value)) continue;
    const cs = colorsIn(value);
    for (const c of cs) {
      if (c.alpha < 0.5) continue;
      bump(all, c.hex, 1);
      if (isBgProp) bump(bg, c.hex, w.root ? 12 : 1);
      if (isFgProp) bump(fg, c.hex, w.root ? 12 : (w.heading ? 2 : 1));
      if (isChromatic(c.hex)) {
        let aw = 1;
        if (w.action) aw += 4;
        if (w.heading) aw += 3;
        if (isBgProp && w.action) aw += 3;
        bump(accent, c.hex, aw);
      }
    }
  }

  for (const n of googleFontNames(fontLinks, html)) {
    const isMono = /mono|code/i.test(n);
    bump(headingFonts, n, isMono ? 0.5 : 3);
    bump(bodyFonts, n, isMono ? 0.5 : 3);
  }

  // ---- roles ----
  const bgTop = topN(bg, 6).map(([h]) => h);
  let background = bgTop[0] || "#ffffff";
  const fgCands = topN(fg, 8).map(([h]) => h).filter((h) => contrast(h, background) >= 4.5);
  let text = fgCands[0] || (lum(background) > 0.4 ? "#1c1b2e" : "#ffffff");
  if (contrast(text, background) < 4.5) text = lum(background) > 0.4 ? "#111111" : "#ffffff";

  const accents = topN(accent, 12).map(([h]) => h)
    .filter((h) => colorDist(h, background) > 60 && colorDist(h, text) > 40);
  const headline = accents[0] || (topN(all, 12).map(([h]) => h).find((h) => isChromatic(h)) ?? (lum(background) > 0.4 ? "#1c1b2e" : "#ffffff"));
  const secondary = accents.find((h) => h !== headline && colorDist(h, headline) > 90)
    || topN(all, 16).map(([h]) => h).find((h) => h !== headline && h !== background && colorDist(h, headline) > 90 && colorDist(h, background) > 40)
    || (lum(background) > 0.4 ? "#c9c6d3" : "#3a3950");

  const hf = topN(headingFonts, 5).map(([n]) => n);
  const bf = topN(bodyFonts, 5).map(([n]) => n);
  const bodyFont = bf[0] || null;
  const headingFont = hf.find((n) => n !== bodyFont) || hf[0] || bodyFont;

  // raw palette for manual picking: role picks first, then other frequent colors
  const palette: string[] = [];
  for (const h of [background, text, headline, secondary, ...accents, ...topN(all, 20).map(([h]) => h)]) {
    if (!palette.some((p) => colorDist(p, h) < 18)) palette.push(h);
    if (palette.length >= 10) break;
  }
  const fonts: string[] = [];
  for (const n of [headingFont, bodyFont, ...hf, ...bf]) if (n && !fonts.includes(n)) fonts.push(n);

  const foundSomething = bg.size + fg.size + accent.size + headingFonts.size + bodyFonts.size > 0;
  return {
    foundSomething,
    confidence: {
      background: bg.size > 0, text: fg.size > 0, headline: accents.length > 0, fonts: fonts.length > 0,
    },
    suggested: {
      background, text, headline, secondary,
      heading_font: headingFont, body_font: bodyFont,
    },
    colors: palette.map((hex) => ({ hex })),
    fonts: fonts.slice(0, 6).map((name) => ({ name })),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const body = await req.json().catch(() => ({}));
    const rawUrl = String(body.url || "").trim();
    if (!rawUrl) return json({ ok: false, error: "Enter your website address first." });

    let parsed: URL;
    try { parsed = normalizeUrl(rawUrl); } catch (e) {
      return json({ ok: false, error: String((e as Error).message || e) });
    }

    let page: { text: string; finalUrl: string };
    try {
      page = await fetchText(parsed.toString(), FETCH_TIMEOUT_MS, MAX_HTML_CHARS);
    } catch (e) {
      const err = e as Error;
      const msg = err.name === "AbortError"
        ? "That site took too long to answer. Try again, or set your colors by hand below."
        : `Couldn't open that site (${String(err.message || err).slice(0, 120)}). Check the address, or set your colors by hand below.`;
      return json({ ok: false, error: msg });
    }

    const { css: sheets, fontLinks } = await linkedCss(page.text, page.finalUrl);
    const css = inlineCss(page.text) + "\n" + sheets;
    const result = analyze(page.text, css, fontLinks);

    if (!result.foundSomething) {
      return json({
        ok: false,
        error: "That page doesn't show its colors or fonts in a way we can read (it's probably built with a page-builder that loads styling by script). Set your colors by hand below — the whole workspace previews live as you pick.",
      });
    }
    return json({ ok: true, source_url: page.finalUrl, ...result });
  } catch (e) {
    console.error(JSON.stringify({ diagnostic: "detect_site_theme_error", message: String(e) }));
    return json({ ok: false, error: "Something went wrong scanning that site. Please try again." });
  }
});
