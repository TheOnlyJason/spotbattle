import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { browserLocalStorageAsync } from '@/lib/browserStorage';

const rawUrl = (
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  (Constants.expoConfig?.extra as { supabaseUrl?: string } | undefined)?.supabaseUrl ??
  ''
).trim();
const rawAnon = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  (Constants.expoConfig?.extra as { supabaseAnonKey?: string } | undefined)?.supabaseAnonKey ??
  ''
).trim();

export const isSupabaseConfigured = Boolean(rawUrl && rawAnon);

/** Non-empty fallbacks so `createClient` never throws during static export when env vars are missing (e.g. Vercel preview without secrets). Real requests still require `isSupabaseConfigured`. */
const url = rawUrl || 'https://placeholder.supabase.co';
const anon = rawAnon || 'sb-placeholder-anon-key-not-configured';

/** In-memory storage for Node / static web export where `window` is undefined. */
function createMemoryAuthStorage() {
  const memory = new Map<string, string>();
  return {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: async (key: string) => {
      memory.delete(key);
    },
  };
}

/**
 * Web: use `localStorage` only — do not pass RN AsyncStorage (Metro can pull the native
 * implementation and throw "Native module is null" in the browser / SSR).
 * Native: AsyncStorage via require so it is not evaluated on web bundles.
 */
function getAuthStorage() {
  if (Platform.OS === 'web') {
    return typeof window === 'undefined' ? createMemoryAuthStorage() : browserLocalStorageAsync;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-async-storage/async-storage').default;
  } catch {
    // Metro / static export can evaluate this path with a non-web Platform; native module is absent in Node.
    return createMemoryAuthStorage();
  }
}

export const supabase = createClient(url, anon, {
  auth: {
    storage: getAuthStorage(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
