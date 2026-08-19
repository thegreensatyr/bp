// Shared Supabase client for the Brandparent app.
// Publishable key is safe to expose client-side -- access is enforced by
// Row Level Security policies on every table in the database.
const SUPABASE_URL = 'https://owxaolqikmgtlegtficq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_CnL2RSce0asA5t3nh14lhA_KtDcbDRR';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Redirect to login if there's no active session. Call at the top of any
// page that requires auth. Returns the session (or redirects and never resolves).
async function requireSession() {
  const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = 'login.html';
            return null;
              }
                return session;
                }
                
