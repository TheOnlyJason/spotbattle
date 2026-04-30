import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export async function ensureAnonSession() {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (e.g. on Vercel).'
    );
  }
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  const again = await supabase.auth.getSession();
  if (!again.data.session) throw new Error('Anonymous sign-in failed');
  return again.data.session;
}
