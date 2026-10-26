// =============================================================================
// Launch Quest — guided first-run setup for BrandParent
// -----------------------------------------------------------------------------
// Five steps, each ticked ONLY from real data (never a guess):
//   1. brand   — at least one cubicle exists
//   2. voice   — a cubicle has a saved voice (tone, audience or vocabulary)
//   3. connect — at least one social account is connected
//   4. second  — at least two cubicles exist (unlocks Bleed Check)
//   5. post    — at least one post has actually published
//
// Also provides, for the whole app:
//   toast(msg, kind, opts)   in-app notices that replace browser alert() popups
//   BPQuest.celebrate(level) chime / sparkle / confetti (respects sound + reduced motion)
//   BPQuest.friendlyError()  plain-English error text
//
// Loaded BEFORE app.html's inline script. It only touches app globals
// (sb, session, cubicles, soundEnabled, playTone, showPanel, openCubicleModal…)
// at call time, never at load time, and everything lives inside this IIFE so
// no top-level names can clash with app.html.
// =============================================================================
(function () {
  'use strict';

  // ---------- Copy: every encouraging line lives here, in one place ----------
  const COPY = {
    justPaid: "You're in. Let's give your first brand a home — five quick steps, and you'll post your first zero-bleed post.",
    intro: 'Most people finish in about 15 minutes. You can pause anytime — we\'ll save your spot.',
    welcomeBackFar: "Welcome back. You're {n} of 5 — the hard part's behind you.",
    welcomeBackNear: 'Welcome back. Pick up right where you left off.',
    allDone: "Setup's done. From here, it's just you and your work.",
    leakCaught: "Caught it. That's the mistake you'll never post again.",
    scheduled: "Scheduled. It'll go out on its own — you don't need to come back for it.",
    steps: {
      brand:   { title: 'Name your first brand', time: 'about 1 min',
                 todo: 'Give one of your brands its own room. Paste your website and we\'ll pull your colors for you.',
                 done: 'Your first cubicle is live. That brand finally has a room of its own.',
                 cta: 'Create my first brand' },
      voice:   { title: 'Teach it your voice', time: 'about 5 min',
                 todo: 'A short chat about how this brand talks. No wrong answers — talk like you\'d talk to a fan.',
                 done: "Now it knows how you sound. Every caption starts from your voice, not a template.",
                 cta: 'Start the interview' },
      connect: { title: 'Connect one account', time: 'about 2 min',
                 todo: 'TikTok is one click. Bluesky and Discord take a copy-paste — we walk you through it.',
                 done: 'Connected. One less tab to juggle.',
                 cta: 'Connect an account' },
      second:  { title: 'Add your second brand', time: 'about 1 min',
                 todo: 'Two brands is where Bleed Check comes alive — it starts guarding each one from the other.',
                 done: 'Two brands, zero overlap. Now watch what Bleed Check does.',
                 cta: 'Add my second brand' },
      post:    { title: 'Send your first post', time: 'about 2 min',
                 todo: 'Write it, let Bleed Check look it over, hit Publish. That\'s the whole job.',
                 done: 'You did it. One of you, all of your brands, zero bleed. 🎉',
                 cta: 'Write my first post' }
    }
  };
  const ORDER = ['brand', 'voice', 'connect', 'second', 'post'];

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const soundOn = () => { try { return typeof soundEnabled === 'undefined' ? true : !!soundEnabled; } catch (e) { return true; } };
  function uid() { try { return (session && session.user && session.user.id) || 'anon'; } catch (e) { return 'anon'; } }
  function lsGet(key, fallback) {
    try { const v = localStorage.getItem('bp_lq_' + key + '_' + uid()); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function lsSet(key, val) { try { localStorage.setItem('bp_lq_' + key + '_' + uid(), JSON.stringify(val)); } catch (e) {} }

  // ---------- Styles (injected once; uses the active cubicle's theme vars) ----------
  const CSS = `
  #launch-quest{max-width:880px;margin:0 auto 22px;position:relative;z-index:2}
  #launch-quest:empty{display:none}
  .lq-card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:22px 24px;box-shadow:0 10px 30px -18px rgba(28,27,46,.35);border-top:4px solid var(--brand)}
  .lq-head{display:flex;align-items:center;gap:18px}
  .lq-ring{flex-shrink:0;width:66px;height:66px;position:relative}
  .lq-ring svg{width:66px;height:66px;transform:rotate(-90deg)}
  .lq-ring .bg{stroke:var(--line)}
  .lq-ring .fg{stroke:var(--brand);transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1)}
  .lq-ring .num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-heading);font-weight:700;font-size:1.05rem;color:var(--ink)}
  .lq-ring .num small{font-size:.72rem;color:var(--muted);font-weight:600;margin-left:1px}
  .lq-titles{flex:1;min-width:0}
  .lq-kicker{font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--brand-text,var(--brand))}
  .lq-titles h2{font-size:1.25rem;margin:2px 0 4px;line-height:1.25}
  .lq-msg{font-size:.88rem;color:var(--muted);line-height:1.5}
  .lq-hide{background:none;border:1.5px solid var(--line);color:var(--muted);border-radius:999px;padding:6px 12px;font-size:.75rem;font-weight:600;align-self:flex-start;flex-shrink:0}
  .lq-hide:hover{color:var(--ink);border-color:var(--muted)}
  .lq-steps{list-style:none;margin:18px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
  .lq-step{display:flex;align-items:flex-start;gap:14px;padding:12px 14px;border-radius:12px;border:1.5px solid transparent;background:var(--cream);transition:background .2s,border-color .2s}
  .lq-step.is-next{background:var(--brand-soft);border-color:var(--brand)}
  .lq-step.is-done{opacity:.92}
  .lq-check{width:28px;height:28px;border-radius:999px;border:2px solid var(--silver);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.8rem;color:var(--muted);background:var(--paper)}
  .lq-step.is-next .lq-check{border-color:var(--brand);color:var(--brand-text,var(--brand))}
  .lq-step.is-done .lq-check{background:var(--brand);border-color:var(--brand);color:var(--on-brand,#fff)}
  .lq-step.just-done .lq-check{animation:lqPop .55s cubic-bezier(.2,1.6,.4,1)}
  @keyframes lqPop{0%{transform:scale(.4)}60%{transform:scale(1.25)}100%{transform:scale(1)}}
  .lq-body{flex:1;min-width:0}
  .lq-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .lq-name{font-weight:700;font-size:.95rem;color:var(--ink)}
  .lq-step.is-done .lq-name{text-decoration:line-through;text-decoration-color:var(--silver);text-decoration-thickness:2px}
  .lq-time{font-size:.7rem;font-weight:600;color:var(--muted);background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
  .lq-tag{font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 8px;background:var(--silver);color:#fff}
  .lq-sub{font-size:.84rem;color:var(--muted);margin-top:3px;line-height:1.5}
  .lq-acts{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
  .lq-go{background:var(--brand);color:var(--on-brand,#fff);border:none;border-radius:999px;padding:9px 18px;font-weight:700;font-size:.85rem}
  .lq-go:hover{filter:brightness(1.07)}
  .lq-later{background:none;border:none;color:var(--muted);font-size:.8rem;font-weight:600;text-decoration:underline;padding:4px}
  .lq-later:hover{color:var(--ink)}
  .lq-foot{margin-top:14px;font-size:.78rem;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
  .lq-foot button{background:none;border:none;color:var(--brand-text,var(--brand));font-weight:700;font-size:.8rem;padding:0;text-decoration:underline}
  .lq-pill{display:none;align-items:center;gap:6px;background:var(--brand-soft);color:var(--brand-text,var(--brand));border:1.5px solid var(--brand);border-radius:999px;padding:6px 12px;font-size:.78rem;font-weight:700;margin-right:6px;white-space:nowrap}
  .lq-pill.show{display:inline-flex}
  /* Bleed Check sandbox — pure in-browser demo, saves nothing */
  .lq-demo{margin-top:12px;background:var(--paper);border:1.5px dashed var(--silver);border-radius:12px;padding:14px}
  .lq-demo h4{font-family:var(--font-heading);font-size:.95rem;margin-bottom:6px}
  .lq-demo p{font-size:.8rem;color:var(--muted);line-height:1.5}
  .lq-demo-brands{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
  .lq-demo-brand{font-size:.75rem;font-weight:700;border-radius:999px;padding:4px 10px;color:#fff}
  .lq-demo textarea{min-height:70px;font-size:.88rem;background:var(--cream)}
  .lq-demo-out{margin-top:8px;font-size:.84rem;font-weight:700;padding:8px 12px;border-radius:10px}
  .lq-demo-out.clean{background:#e7f4ec;color:#1f5c3a}
  .lq-demo-out.dirty{background:#fbe9e7;color:#8f1d12}
  /* Toasts */
  #bp-toasts{position:fixed;right:18px;top:72px;z-index:400;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 32px));pointer-events:none}
  .bp-toast{pointer-events:auto;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-left:5px solid var(--brand);border-radius:14px;padding:12px 38px 12px 14px;box-shadow:0 14px 34px -14px rgba(28,27,46,.45);font-size:.88rem;line-height:1.45;position:relative;animation:bpToastIn .28s ease-out}
  .bp-toast.error{border-left-color:#c0392b}
  .bp-toast.info{border-left-color:var(--silver)}
  .bp-toast b{display:block;font-family:var(--font-heading);font-size:.95rem;margin-bottom:2px}
  .bp-toast .x{position:absolute;top:6px;right:8px;background:none;border:none;color:var(--muted);font-size:1.1rem;line-height:1;padding:4px}
  .bp-toast.out{opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}
  @keyframes bpToastIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  #bp-confetti{position:fixed;inset:0;pointer-events:none;z-index:450}
  .bp-sparkle{position:fixed;pointer-events:none;z-index:450;font-size:1.4rem;animation:bpSpark 1s ease-out forwards}
  @keyframes bpSpark{0%{opacity:0;transform:translate(-50%,-50%) scale(.4)}25%{opacity:1}100%{opacity:0;transform:translate(-50%,-160%) scale(1.3)}}
  .bp-helper{margin:4px 0 12px;padding:10px 12px;border-radius:10px;background:var(--cream);border:1px solid var(--line)}
  .bp-helper ol{margin:6px 0 0 18px;padding:0;font-size:.82rem;line-height:1.6;color:var(--ink)}
  .bp-helper .k{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--brand-text,var(--brand))}
  .bp-helper a{color:var(--brand-text,var(--brand));font-weight:700}
  .bp-soon{display:inline-block;font-size:.66rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;background:var(--silver);color:#fff;border-radius:999px;padding:3px 9px;margin-left:6px;vertical-align:middle}
  .m-detect{background:var(--brand-soft);border:1.5px solid var(--brand);border-radius:12px;padding:12px 14px;margin:14px 0 4px}
  .m-detect .row{display:flex;gap:8px;margin-top:6px}
  .m-detect .row input{flex:1;margin:0}
  .m-detect-out{font-size:.8rem;margin-top:8px;color:var(--muted)}
  .m-detect-out .sw{display:inline-block;width:16px;height:16px;border-radius:5px;vertical-align:middle;margin-right:3px;border:1px solid rgba(0,0,0,.12)}
  @media(max-width:700px){
    #launch-quest{margin-bottom:16px}
    .lq-card{padding:16px}
    .lq-head{gap:12px}
    .lq-ring,.lq-ring svg{width:54px;height:54px}
    .lq-titles h2{font-size:1.08rem}
    .lq-step{padding:10px 12px;gap:10px}
    .lq-pill{padding:5px 10px}
    .lq-pill .lq-pill-word{display:none}
    #bp-toasts{right:12px;left:12px;top:12px;max-width:none}
  }
  @media (prefers-reduced-motion: reduce){
    .lq-ring .fg,.lq-step,.bp-toast{transition:none!important;animation:none!important}
    .lq-step.just-done .lq-check{animation:none}
  }`;
  function injectCss() {
    if ($('lq-css')) return;
    const st = document.createElement('style');
    st.id = 'lq-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ======================= Toasts (replace alert) ============================
  function toastHost() {
    let h = $('bp-toasts');
    if (!h) {
      h = document.createElement('div');
      h.id = 'bp-toasts';
      h.setAttribute('role', 'status');
      h.setAttribute('aria-live', 'polite');
      document.body.appendChild(h);
    }
    return h;
  }
  // kind: 'success' | 'error' | 'info'.  opts.title, opts.duration (ms, 0 = stay until closed)
  function toast(msg, kind, opts) {
    injectCss();
    kind = kind || 'info';
    opts = opts || {};
    const host = toastHost();
    // One encouraging line at a time: a new notice replaces older non-error ones (errors stay until read).
    Array.from(host.children).forEach(c => { if (!c.classList.contains('error')) c.remove(); });
    while (host.children.length >= 2) host.removeChild(host.firstChild);
    const el = document.createElement('div');
    el.className = 'bp-toast ' + kind;
    if (kind === 'error') el.setAttribute('role', 'alert');
    el.innerHTML = (opts.title ? '<b>' + esc(opts.title) + '</b>' : '') + '<span></span>' +
      '<button class="x" aria-label="Dismiss">×</button>';
    el.querySelector('span').textContent = String(msg == null ? '' : msg);
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
    el.querySelector('.x').onclick = close;
    host.appendChild(el);
    const dur = opts.duration != null ? opts.duration : (kind === 'error' ? 9000 : Math.min(9000, 3800 + String(msg || '').length * 35));
    if (dur > 0) setTimeout(close, dur);
    return el;
  }

  // ======================= Plain-English errors ===============================
  function friendlyError(platform, raw) {
    const m = String(raw || '').replace(/^Error:\s*/, '');
    const low = m.toLowerCase();
    if (/failed to fetch|networkerror|network request failed|load failed/.test(low))
      return "Couldn't reach the server — check your internet connection and try again.";
    if (/jwt|session|not authenticated|unauthorized|401/.test(low))
      return 'Your login timed out. Refresh the page, then try again — nothing you typed is lost.';
    if (platform === 'bluesky') {
      if (/bluesky_auth_failed|invalid identifier or password|authentication required|rejected that handle|invalid handle/.test(low))
        return "Bluesky didn't accept that — make sure it's an App Password (looks like xxxx-xxxx-xxxx-xxxx), not your login password, and that the handle is spelled exactly right (e.g. yourname.bsky.social).";
      if (/rate|too many/.test(low)) return 'Bluesky asked us to slow down. Wait a minute, then try again.';
    }
    if (platform === 'discord') {
      if (/webhook_not_found|doesn't exist|unknown webhook/.test(low))
        return 'Discord says that webhook was deleted. Make a new one (Server Settings → Integrations → Webhooks) and paste its URL.';
    }
    if (/non-2xx|edge function/.test(low)) return 'Something went wrong on our side. Try again in a minute — if it keeps happening, let us know.';
    return m || 'Something went wrong. Try again in a minute.';
  }

  // ======================= Celebrations ======================================
  function chime(level) {
    if (!soundOn() || typeof playTone !== 'function') return;
    if (level === 'big') playTone([523.25, 659.25, 783.99, 1046.5], [0.12, 0.12, 0.12, 0.42], 'sine', 0.14);
    else if (level === 'medium') playTone([659.25, 830.61, 987.77], [0.1, 0.1, 0.3], 'sine', 0.13);
    else if (typeof playRewardTone === 'function') playRewardTone();
  }
  function brandColors() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (v, f) => (cs.getPropertyValue(v) || '').trim() || f;
    return [pick('--brand', '#9B7FC4'), pick('--brand-secondary', '#c9c6d3'), '#f4c95d', '#ffffff', pick('--silver', '#c9c6d3')];
  }
  function sparkle(anchor) {
    if (reducedMotion()) return;
    let x = window.innerWidth / 2, y = window.innerHeight / 3;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      if (r.width) { x = r.left + r.width / 2; y = r.top + r.height / 2; }
    }
    ['✦', '✧', '✦'].forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'bp-sparkle';
      s.textContent = ch;
      s.style.left = (x + (i - 1) * 22) + 'px';
      s.style.top = y + 'px';
      s.style.color = brandColors()[i % 2];
      s.style.animationDelay = (i * 0.08) + 's';
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 1300);
    });
  }
  function confetti() {
    if (reducedMotion()) return;
    const old = $('bp-confetti'); if (old) old.remove();
    const cv = document.createElement('canvas');
    cv.id = 'bp-confetti';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    if (!ctx) { cv.remove(); return; }
    ctx.scale(dpr, dpr);
    const cols = brandColors();
    const N = innerWidth < 600 ? 90 : 160;
    const parts = Array.from({ length: N }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.38,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      c: cols[Math.floor(Math.random() * cols.length)]
    }));
    const t0 = performance.now();
    (function frame(t) {
      const el = t - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts.forEach(p => {
        p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.globalAlpha = Math.max(0, 1 - el / 3200);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * 0.6);
        ctx.restore();
      });
      if (el < 3200) requestAnimationFrame(frame); else cv.remove();
    })(t0);
  }
  // level: 'small' | 'medium' | 'big'
  function celebrate(level, anchor) {
    chime(level);
    if (level === 'big') confetti();
    else if (level === 'medium') sparkle(anchor);
  }

  // ======================= Quest state ========================================
  let started = false;
  let counts = { connected: 0, published: 0 };
  let celebrated = {};   // step -> true once its "done" moment has fired (persisted)
  let justDone = null;   // step id to animate on next render
  let flash = '';        // one-time message shown in the header

  async function fetchCounts() {
    try {
      const [a, p] = await Promise.all([
        sb.from('social_accounts').select('id', { count: 'exact', head: true }),
        sb.from('drafts').select('id', { count: 'exact', head: true }).eq('status', 'published')
      ]);
      if (!a.error && typeof a.count === 'number') counts.connected = a.count;
      if (!p.error && typeof p.count === 'number') counts.published = p.count;
    } catch (e) { /* keep last known counts — never invent progress */ }
  }

  function hasVoice(c) {
    return !!(c && ((c.tone && String(c.tone).trim()) || (c.audience && String(c.audience).trim()) ||
      (Array.isArray(c.lexicon) && c.lexicon.length) || (Array.isArray(c.signature_phrases) && c.signature_phrases.length)));
  }
  function state() {
    const list = (typeof cubicles !== 'undefined' && Array.isArray(cubicles)) ? cubicles : [];
    return {
      brand: list.length >= 1,
      voice: list.some(hasVoice),
      connect: counts.connected >= 1,
      second: list.length >= 2,
      post: counts.published >= 1
    };
  }
  const doneCount = (s) => ORDER.filter(k => s[k]).length;
  function nextStep(s) {
    const skipped = lsGet('skip', {});
    return ORDER.find(k => !s[k] && !skipped[k]) || ORDER.find(k => !s[k]) || null;
  }

  // ======================= Rendering ==========================================
  function ring(n) {
    const R = 28, C = 2 * Math.PI * R, off = C * (1 - n / 5);
    return `<div class="lq-ring" aria-hidden="true"><svg viewBox="0 0 66 66">
      <circle class="bg" cx="33" cy="33" r="${R}" fill="none" stroke-width="7"/>
      <circle class="fg" cx="33" cy="33" r="${R}" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
    </svg><div class="num">${n}<small>/5</small></div></div>`;
  }

  function demoHtml() {
    return `<div class="lq-demo" id="lq-demo">
      <h4>Try Bleed Check right now</h4>
      <p>Pretend you run these two brands. You're writing as <b>Iron Hour Gym</b> — type a bakery word like <b>sourdough</b> and watch it get caught. (Just a demo — nothing is saved.)</p>
      <div class="lq-demo-brands">
        <span class="lq-demo-brand" style="background:#7a3e1d">Midnight Bakery: sourdough · crumb · proof box</span>
        <span class="lq-demo-brand" style="background:#26374a">Iron Hour Gym ← writing as</span>
      </div>
      <textarea id="lq-demo-text" aria-label="Bleed Check demo text" placeholder="e.g. New 6am class! Bring your energy — and maybe a sourdough loaf for after."></textarea>
      <div class="lq-demo-out clean" id="lq-demo-out">✓ Clean — this reads as Iron Hour Gym</div>
    </div>`;
  }
  const DEMO_TERMS = ['Midnight Bakery', 'sourdough', 'crumb', 'proof box'];
  let demoWasDirty = false;
  function runDemo() {
    const ta = $('lq-demo-text'), out = $('lq-demo-out');
    if (!ta || !out) return;
    const text = ta.value;
    const hits = DEMO_TERMS.filter(t => new RegExp('(^|[^A-Za-z0-9])' + t.replace(/\s+/g, '\\s+') + '(?=[^A-Za-z0-9]|$)', 'i').test(text));
    if (hits.length) {
      out.className = 'lq-demo-out dirty';
      out.textContent = '⚠ Caught: "' + hits.join('", "') + '" belongs to Midnight Bakery. That\'s a leak you\'ll never post by accident.';
      if (!demoWasDirty) { if (typeof playBleedAlert === 'function') playBleedAlert(); sparkle(out); }
      demoWasDirty = true;
    } else {
      out.className = 'lq-demo-out clean';
      out.textContent = '✓ Clean — this reads as Iron Hour Gym';
      if (demoWasDirty && typeof playBleedClean === 'function') playBleedClean();
      demoWasDirty = false;
    }
  }

  function headerMessage(s, n) {
    if (flash) return flash;
    if (n === 0) return COPY.intro;
    const nx = nextStep(s);
    if (nx) return 'Next up: ' + COPY.steps[nx].title.toLowerCase() + ' — ' + COPY.steps[nx].time + '.';
    return COPY.intro;
  }

  function render() {
    const host = $('launch-quest');
    if (!host) return;
    const s = state();
    const n = doneCount(s);
    const pill = $('lq-pill');

    if (n === 5 || lsGet('finished', false)) {
      host.innerHTML = '';
      if (pill) pill.classList.remove('show');
      setEmptyStateVisible(true);
      return;
    }
    if (pill) {
      pill.querySelector('.lq-pill-n').textContent = n + '/5';
    }
    if (lsGet('minimized', false)) {
      host.innerHTML = '';
      if (pill) pill.classList.add('show');
      setEmptyStateVisible(true);
      return;
    }
    if (pill) pill.classList.remove('show');

    const skipped = lsGet('skip', {});
    const nx = nextStep(s);
    const showDemo = !s.second;
    const rows = ORDER.map((k, i) => {
      const c = COPY.steps[k];
      const done = s[k];
      const isNext = k === nx;
      const isSkipped = !done && skipped[k];
      const sub = done ? c.done : c.todo;
      const acts = done ? '' : `<div class="lq-acts">
          <button class="lq-go" type="button" onclick="BPQuest.go('${k}')">${esc(isSkipped ? 'Pick this back up' : c.cta)}</button>
          ${isSkipped ? '' : `<button class="lq-later" type="button" onclick="BPQuest.later('${k}')">Do this later</button>`}
        </div>`;
      const demo = (k === 'second' && showDemo && isNext) ? demoHtml() : '';
      return `<li class="lq-step ${done ? 'is-done' : ''} ${isNext ? 'is-next' : ''} ${justDone === k ? 'just-done' : ''}" id="lq-step-${k}">
        <span class="lq-check">${done ? '✓' : (i + 1)}</span>
        <div class="lq-body">
          <div class="lq-row"><span class="lq-name">${esc(c.title)}</span>
            ${done ? '' : `<span class="lq-time">${esc(c.time)}</span>`}
            ${isSkipped ? '<span class="lq-tag">Later</span>' : ''}</div>
          <div class="lq-sub">${esc(sub)}</div>
          ${(isNext || isSkipped) ? acts : ''}
          ${demo}
        </div></li>`;
    }).join('');

    host.innerHTML = `<section class="lq-card" aria-labelledby="lq-title">
      <div class="lq-head">
        ${ring(n)}
        <div class="lq-titles">
          <div class="lq-kicker">Launch Quest</div>
          <h2 id="lq-title">${n === 0 ? 'Five steps to your first zero-bleed post' : (n >= 3 ? 'Almost there' : 'You\'re on your way')}</h2>
          <div class="lq-msg" id="lq-msg">${esc(headerMessage(s, n))}</div>
        </div>
        <button class="lq-hide" type="button" onclick="BPQuest.minimize()" title="Tuck this away — reopen it from the top bar">Hide</button>
      </div>
      <ol class="lq-steps">${rows}</ol>
      <div class="lq-foot"><span>Your progress saves automatically.</span>
        ${showDemo && nx !== 'second' ? '<button type="button" onclick="BPQuest.showDemo()">Try Bleed Check now</button>' : ''}</div>
    </section>`;

    const ta = $('lq-demo-text');
    if (ta) ta.addEventListener('input', runDemo);
    setEmptyStateVisible(false);
    justDone = null;
  }

  // The quest replaces the plain "Set up your first cubicle" box while it's on screen.
  function setEmptyStateVisible(questHidden) {
    const empty = $('no-cubicles');
    if (!empty) return;
    const list = (typeof cubicles !== 'undefined' && Array.isArray(cubicles)) ? cubicles : [];
    if (list.length) return; // loadCubicles owns it once brands exist
    empty.style.display = questHidden ? 'block' : 'none';
  }

  function ensurePill() {
    if ($('lq-pill')) return;
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const b = document.createElement('button');
    b.id = 'lq-pill';
    b.type = 'button';
    b.className = 'lq-pill';
    b.title = 'Open your Launch Quest';
    b.innerHTML = '🚀 <span class="lq-pill-word">Launch Quest</span> <span class="lq-pill-n">0/5</span>';
    b.onclick = () => BPQuest.open();
    const sound = $('sound-toggle-btn');
    bar.insertBefore(b, sound || null);
  }

  // ======================= Progress + celebration =============================
  // Resolves true when a quest step was just completed (and celebrated), so callers can skip their own toast.
  async function refresh(opts) {
    if (!started) return false;
    opts = opts || {};
    if (opts.fetch !== false) await fetchCounts();
    const s = state();
    const newly = ORDER.filter(k => s[k] && !celebrated[k]);
    // A step that un-does itself (e.g. a brand deleted) can be celebrated again later.
    ORDER.forEach(k => { if (!s[k] && celebrated[k]) delete celebrated[k]; });
    newly.forEach(k => { celebrated[k] = true; });
    lsSet('celebrated', celebrated);

    const n = doneCount(s);
    if (newly.length) {
      const k = newly[newly.length - 1];
      justDone = k;
      if (n === 5 && !lsGet('finished', false)) {
        lsSet('finished', true);
        celebrate('big');
        toast(COPY.steps.post.done + ' ' + COPY.allDone, 'success', { title: 'Launch Quest complete', duration: 9000 });
      } else if (k === 'post') {
        celebrate('big');
        toast(COPY.steps.post.done, 'success', { title: 'First post is live' });
      } else {
        const nx = nextStep(s);
        flash = nx ? 'Nice work. Next up: ' + COPY.steps[nx].title.toLowerCase() + ' — ' + COPY.steps[nx].time + '.' : 'Nice work.';
        celebrate('medium', $('launch-quest'));
        toast(COPY.steps[k].done, 'success', { title: (n) + ' of 5 done' });
      }
      // un-skip anything now finished
      const sk = lsGet('skip', {}); newly.forEach(x => delete sk[x]); lsSet('skip', sk);
    }
    render();
    if (newly.length && !lsGet('minimized', false)) {
      const card = $('launch-quest');
      if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
    return newly.length > 0;
  }

  async function start() {
    if (started) return refresh();
    injectCss();
    // ?quest=reset — wipe this browser's quest memory (for testing the first-run experience).
    try {
      if (new URLSearchParams(location.search).get('quest') === 'reset') {
        ['celebrated', 'skip', 'minimized', 'finished', 'lastSeen', 'leakCelebrated'].forEach(k => {
          try { localStorage.removeItem('bp_lq_' + k + '_' + uid()); } catch (e) {}
        });
        const u = new URL(location.href); u.searchParams.delete('quest'); history.replaceState({}, '', u.pathname + u.search);
      }
    } catch (e) {}
    started = true;
    ensurePill();
    celebrated = lsGet('celebrated', null);
    await fetchCounts();
    const s = state();
    const n = doneCount(s);
    if (celebrated === null) {
      // First time this browser sees the quest: don't throw a party for work already done.
      celebrated = {};
      ORDER.forEach(k => { if (s[k]) celebrated[k] = true; });
      lsSet('celebrated', celebrated);
      if (n === 5) lsSet('finished', true); // existing fully-set-up users never see it
    } else {
      // Catch up quietly on anything finished in another tab/device.
      ORDER.forEach(k => { if (s[k]) celebrated[k] = true; });
      lsSet('celebrated', celebrated);
    }

    if (window.BP_JUST_PAID) {
      flash = COPY.justPaid;
      lsSet('minimized', false);
      setTimeout(() => celebrate('medium', $('launch-quest')), 400);
    } else {
      const last = lsGet('lastSeen', 0);
      if (last && Date.now() - last > 30 * 60 * 1000 && n > 0 && n < 5) {
        flash = n >= 2 ? COPY.welcomeBackFar.replace('{n}', n) : COPY.welcomeBackNear;
      }
    }
    lsSet('lastSeen', Date.now());
    render();
    setTimeout(() => { flash = ''; }, 60 * 1000);
  }

  // ======================= Step actions =======================================
  function tab(name) {
    const btn = document.querySelector('.tab[data-panel="' + name + '"]');
    if (btn && typeof showPanel === 'function') showPanel(name, btn);
  }
  function scrollTo(id) {
    const el = $(id);
    if (el) el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }
  function go(k) {
    const sk = lsGet('skip', {}); delete sk[k]; lsSet('skip', sk);
    const list = (typeof cubicles !== 'undefined' && Array.isArray(cubicles)) ? cubicles : [];
    if (k === 'brand' || k === 'second') { if (typeof openCubicleModal === 'function') openCubicleModal(); return; }
    if (!list.length) { if (typeof openCubicleModal === 'function') openCubicleModal(); return; }
    if (k === 'voice') {
      tab('voice');
      setTimeout(() => { scrollTo('interview-card'); const b = $('interview-start-btn'); if (b && b.offsetParent) b.focus(); }, 120);
      toast('No wrong answers. Talk like you\'d talk to a fan.', 'info', { title: 'About 5 minutes' });
      return;
    }
    if (k === 'connect') { tab('connections'); setTimeout(() => scrollTo('panel-connections'), 120); return; }
    if (k === 'post') {
      tab('compose');
      setTimeout(() => { scrollTo('draft'); const d = $('draft'); if (d) d.focus(); }, 120);
      if (counts.connected < 1) toast('Connect one account first so your post has somewhere to go — the Accounts tab takes about 2 minutes.', 'info');
      return;
    }
  }
  function later(k) {
    const sk = lsGet('skip', {}); sk[k] = true; lsSet('skip', sk);
    toast('No problem — it\'ll be right here when you\'re ready.', 'info');
    render();
  }
  function minimize() { lsSet('minimized', true); render(); toast('Tucked away. Tap 🚀 in the top bar to bring it back.', 'info'); }
  function open() { lsSet('minimized', false); render(); const h = $('launch-quest'); if (h) h.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); }
  function showDemo() {
    const host = $('launch-quest');
    if (!host || $('lq-demo')) return;
    const foot = host.querySelector('.lq-foot');
    if (!foot) return;
    foot.insertAdjacentHTML('beforebegin', demoHtml());
    const ta = $('lq-demo-text');
    if (ta) { ta.addEventListener('input', runDemo); ta.focus(); }
  }

  // ======================= Hooks called from app.html ========================
  async function onCubicleCreated(c) {
    const stepped = await refresh({ fetch: false });
    if (!stepped) {
      celebrate('small');
      toast((c && c.name ? '"' + c.name + '"' : 'Your new brand') + ' has a room of its own now. Nothing bleeds in or out.', 'success', { title: 'Cubicle created' });
    }
    return stepped;
  }
  function onVoiceSaved() { return refresh({ fetch: false }); }
  function onConnected() { return refresh(); }
  function onPublished() { return refresh(); }
  function onScheduled() { toast(COPY.scheduled, 'success', { title: 'On the calendar' }); }
  function onLeakCaught() {
    if (!started || lsGet('leakCelebrated', false)) return;
    lsSet('leakCelebrated', true);
    celebrate('medium', $('bleed-status'));
    toast(COPY.leakCaught, 'success', { title: 'Bleed Check just saved you' });
  }

  window.toast = toast;
  window.BPQuest = {
    start, refresh, render, go, later, minimize, open, showDemo,
    celebrate, friendlyError, toast,
    onCubicleCreated, onVoiceSaved, onConnected, onPublished, onScheduled, onLeakCaught,
    _state: state, _copy: COPY
  };
})();
