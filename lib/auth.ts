import { supabase } from '@/lib/supabase';

export async function ensureAnonSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  const again = await supabase.auth.getSession();
  if (!again.data.session) throw new Error('Anonymous sign-in failed');
  return again.data.session;
}
