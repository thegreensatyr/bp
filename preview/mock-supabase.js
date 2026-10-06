// PREVIEW ONLY — never loaded by app.html. Stands in for supabase-js + js/supabase-client.js
// so preview-before.html / preview-after.html render a logged-in workspace with demo data.
(function () {
  const now = Date.now(), day = 86400000;
  // Demo cubicles = the owner's own brands. DJ Green Satyr, Cursed Worlds and Virgo Focused use their REAL
  // saved colors, fonts, logo (and photo) as read from Supabase on 2026-10-06 (read-only); theme_style is
  // demo-only here and is NOT written to the real cubicles. Satyr Arcana has no saved cubicle yet, so its
  // look is a placeholder awaiting the owner's input.
  const ST = 'https://owxaolqikmgtlegtficq.supabase.co/storage/v1/object/public/cubicle-logos/aa91e4e0-594f-4189-9b60-5c599c8a48fa/';
  const cubicles = [
    { id: 'c1', name: 'DJ Green Satyr', icon_initials: 'DJ', color: '#050a05', secondary_color: '#4bc800',
      background_color: '#16321f', text_color: '#e8cd85', font_heading: 'Bebas Neue', font_body: 'Inter',
      logo_url: ST + 'ef7d9143-a0d2-4525-b09b-08736caee98e-logo?t=1790119975589',
      background_image_url: ST + 'ef7d9143-a0d2-4525-b09b-08736caee98e-bg?t=1790149182331', background_overlay: 55,
      theme_style: { v: 1, bg: 'photo', tone: 'base', card: 'frosted', opacity: 0.66, radius: 'sharp' },
      tone: 'Dark, theatrical, bold. Speaks from the stage.', audience: 'House & techno heads, festival crowd',
      signature_phrases: ['see you on the floor', 'hooves up'], lexicon: ['satyr set', 'forest rave', 'the grove'],
      never_says: ['corporate synergy'], created_at: '2026-01-01' },
    { id: 'c2', name: 'Satyr Arcana', icon_initials: 'SA', color: '#4a148c', secondary_color: '#c5b3e6',
      background_color: '#1a1230', text_color: '#ece6f7', font_heading: 'Cinzel', font_body: 'Lora', logo_url: '',
      theme_style: { v: 1, bg: 'starfield', tone: 'base', card: 'outline', opacity: 0.58, radius: 'soft' },
      tone: 'Mystical, poetic, cinematic', audience: 'Tarot lovers, art-house audiences',
      signature_phrases: ['the cards remember'], lexicon: ['moon reading', 'arcana', 'the cards'], never_says: [], created_at: '2026-01-02' },
    { id: 'c3', name: 'Cursed Worlds', icon_initials: 'CW', color: '#6b1620', secondary_color: '#1565c0',
      background_color: '#26374a', text_color: '#faf7f2', font_heading: 'Bitter', font_body: 'Space Grotesk',
      logo_url: ST + 'c5aef671-239d-49ec-9534-b1214fc78ed6-logo?t=1790085897731',
      background_image_url: ST + 'c5aef671-239d-49ec-9534-b1214fc78ed6-bg?t=1790120150408', background_overlay: 55,
      theme_style: { v: 1, bg: 'mist', tone: 'deep', card: 'frosted', opacity: 0.72, radius: 'sharp' },
      tone: 'Eerie, cinematic, lore-heavy', audience: 'Horror and dark-fantasy fans',
      signature_phrases: ['enter if you dare'], lexicon: ['cursed', 'the hollow'], never_says: [], created_at: '2026-01-03' },
    { id: 'c4', name: 'Virgo Focused', icon_initials: 'vf', color: '#9B7FC4', secondary_color: '#5f7d54',
      background_color: '#f4ede2', text_color: '#2a2940', font_heading: 'Fraunces', font_body: 'Inter',
      logo_url: ST + 'b74269c9-edd4-4d08-84e3-305b5e83b558-logo?t=1787438958729', background_image_url: null, background_overlay: 55,
      theme_style: { v: 1, bg: 'dots', tone: 'tint', card: 'solid', opacity: 1, radius: 'round' },
      tone: 'Calm, organized, encouraging', audience: 'Planners and busy creatives',
      signature_phrases: ['organize, prioritize, breathe easy'], lexicon: ['brain dump', 'weekly reset'], never_says: [], created_at: '2026-01-04' }
  ];
  const social = [
    { id: 's1', cubicle_id: 'c1', platform: 'bluesky', external_account_name: 'djgreensatyr.bsky.social' },
    { id: 's2', cubicle_id: 'c1', platform: 'facebook', external_account_name: 'DJ Green Satyr' },
    { id: 's3', cubicle_id: 'c1', platform: 'instagram', external_account_name: '@djgreensatyr' },
    { id: 's4', cubicle_id: 'c1', platform: 'tiktok', external_account_name: '@djgreensatyr' },
    { id: 's5', cubicle_id: 'c1', platform: 'discord', external_account_name: 'GreenSatyr #announcements' }
  ];
  const drafts = [
    { id: 'd1', cubicle_id: 'c1', status: 'scheduled', content: 'Friday: two-hour forest rave set, doors at 9. See you on the floor.', scheduled_for: new Date(now + 2 * day).toISOString() },
    { id: 'd2', cubicle_id: 'c1', status: 'scheduled', content: 'New mix drop — bass in the forest vol. 3 is live everywhere.', scheduled_for: new Date(now + 5 * day).toISOString() },
    { id: 'd3', cubicle_id: 'c1', status: 'scheduled', content: 'Throwback to the sunrise set at Lightning in a Bottle.', scheduled_for: new Date(now + 9 * day).toISOString() }
  ];
  const tables = {
    profiles: [{ id: 'u1', parent_name: 'Britannic Zane', subscription_status: 'active', tutorials_enabled: false }],
    cubicles, social_accounts: social, drafts
  };
  function builder(table) {
    let rows = (tables[table] || []).slice(), one = false;
    const b = {
      select() { return b; }, order() { return b; }, limit() { return b; },
      insert() { rows = [{ id: 'new' }]; return b; }, update() { return b; }, delete() { return b; }, upsert() { return b; },
      eq(col, val) { rows = rows.filter(r => !(col in r) || r[col] === val); return b; },
      single() { one = true; return b; }, maybeSingle() { one = true; return b; },
      then(res, rej) { return Promise.resolve({ data: one ? (rows[0] || null) : rows, error: null }).then(res, rej); }
    };
    return b;
  }
  const session = { user: { id: 'u1', email: 'demo@example.com', user_metadata: {} }, access_token: 'mock' };
  window.sb = {
    auth: {
      getSession: async () => ({ data: { session } }),
      refreshSession: async () => ({ data: { session } }),
      getUser: async () => ({ data: { user: session.user } }),
      signOut: async () => ({}), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    from: builder,
    storage: { from: () => ({ upload: async () => ({}), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
    functions: {
      invoke: async (name) => {
        if (name === 'tiktok-creator-info') return { data: { creator_nickname: 'DJ Green Satyr', creator_username: 'djgreensatyr',
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], max_video_post_duration_sec: 600 }, error: null };
        return { data: {}, error: null };
      }
    }
  };
  window.SUPABASE_URL = 'https://example.invalid';
  window.requireSession = async () => session;
  try { localStorage.setItem('bp_active_cubicle_u1', 'c1'); } catch (e) {}
})();
