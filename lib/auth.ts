import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export async function ensureAnonSession() {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (e.g. on Vercel).'
    );
  }
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) {
    // Verify the session is still valid on the server (catches stale tokens after project restores).
    const { error: userError } = await supabase.auth.getUser();
    if (!userError) return sessionData.session;
    // Invalid session — clear it and fall through to re-sign-in.
    await supabase.auth.signOut();
  }
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  const again = await supabase.auth.getSession();
  if (!again.data.session) throw new Error('Anonymous sign-in failed');
  return again.data.session;
}
