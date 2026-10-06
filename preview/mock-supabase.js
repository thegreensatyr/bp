// PREVIEW ONLY — never loaded by app.html. Stands in for supabase-js + js/supabase-client.js
// so preview-before.html / preview-after.html render a logged-in workspace with demo data.
(function () {
  const now = Date.now(), day = 86400000;
  const cubicles = [
    { id: 'c1', name: 'DJ Green Satyr', icon_initials: 'GS', color: '#2f7d4f', secondary_color: '#c9c6d3',
      background_color: '#f3efe4', text_color: '#1d2a1f', font_heading: 'Fraunces', font_body: 'Inter',
      tone: 'Playful, euphoric, underground', audience: 'House & techno heads, festival crowd',
      signature_phrases: ['see you on the floor', 'bass in the forest'], lexicon: ['satyr set', 'forest rave'],
      never_says: ['corporate synergy'], logo_url: '', created_at: '2026-01-01' },
    { id: 'c2', name: 'Satyr Arcana', icon_initials: 'SA', color: '#5b2a86', secondary_color: '#d4a5c9',
      background_color: '#f6f0fa', text_color: '#24132f', font_heading: 'Fraunces', font_body: 'Inter',
      tone: 'Mystical, warm, reflective', audience: 'Tarot & ritual community',
      signature_phrases: ['the cards remember'], lexicon: ['moon reading', 'arcana'], never_says: [], created_at: '2026-01-02' },
    { id: 'c3', name: 'Brandparent', icon_initials: 'BP', color: '#5B2A86', secondary_color: '#DCD8E6',
      background_color: '#F5F3F9', text_color: '#2A1F3D', font_heading: 'Fraunces', font_body: 'Inter',
      tone: 'Clear, friendly, founder-led', audience: 'Multi-brand creators',
      signature_phrases: ['zero bleed', 'see you on the floor'], lexicon: ['cubicle', 'bleed check', 'forest rave'], never_says: [], created_at: '2026-01-03' }
  ];
  const social = [
    { id: 's1', cubicle_id: 'c3', platform: 'bluesky', external_account_name: 'djgreensatyr.bsky.social' },
    { id: 's2', cubicle_id: 'c3', platform: 'facebook', external_account_name: 'DJ Green Satyr' },
    { id: 's3', cubicle_id: 'c3', platform: 'instagram', external_account_name: '@djgreensatyr' },
    { id: 's4', cubicle_id: 'c3', platform: 'tiktok', external_account_name: '@djgreensatyr' },
    { id: 's5', cubicle_id: 'c3', platform: 'discord', external_account_name: 'GreenSatyr #announcements' }
  ];
  const drafts = [
    { id: 'd1', cubicle_id: 'c3', status: 'scheduled', content: 'Friday: two-hour forest rave set, doors at 9. See you on the floor.', scheduled_for: new Date(now + 2 * day).toISOString() },
    { id: 'd2', cubicle_id: 'c3', status: 'scheduled', content: 'New mix drop — bass in the forest vol. 3 is live everywhere.', scheduled_for: new Date(now + 5 * day).toISOString() },
    { id: 'd3', cubicle_id: 'c3', status: 'scheduled', content: 'Throwback to the sunrise set at Lightning in a Bottle.', scheduled_for: new Date(now + 9 * day).toISOString() }
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
  try { localStorage.setItem('bp_active_cubicle_u1', 'c3'); } catch (e) {}
})();
