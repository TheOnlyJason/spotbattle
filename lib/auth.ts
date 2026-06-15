import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export const BACKEND_UNAVAILABLE_MESSAGE =
  'The spotBattle backend is paused right now. If you want to play, contact me.';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? '');
}

function isBackendUnavailableError(error: unknown): boolean {
  const lower = errorMessage(error).toLowerCase();
  return (
    lower.includes('failed to fetch') ||
    lower.includes('network request failed') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('err_name_not_resolved') ||
    lower.includes('anonymous sign-in failed') ||
    lower.includes('supabase is not configured') ||
    lower.includes('fetch failed')
  );
}

export function formatUserFacingError(error: unknown, fallback = 'Something went wrong'): string {
  if (isBackendUnavailableError(error)) return BACKEND_UNAVAILABLE_MESSAGE;
  const msg = errorMessage(error);
  return msg || fallback;
}

export async function ensureAnonSession() {
  if (!isSupabaseConfigured) {
    throw new Error(BACKEND_UNAVAILABLE_MESSAGE);
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
  if (error) {
    if (isBackendUnavailableError(error)) throw new Error(BACKEND_UNAVAILABLE_MESSAGE);
    throw error;
  }
  const again = await supabase.auth.getSession();
  if (!again.data.session) throw new Error(BACKEND_UNAVAILABLE_MESSAGE);
  return again.data.session;
}
