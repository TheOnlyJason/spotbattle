import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { browserLocalStorageAsync } from '@/lib/browserStorage';

const url =
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  (Constants.expoConfig?.extra as { supabaseUrl?: string } | undefined)?.supabaseUrl ??
  '';
const anon =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  (Constants.expoConfig?.extra as { supabaseAnonKey?: string } | undefined)?.supabaseAnonKey ??
  '';

export const isSupabaseConfigured = Boolean(url && anon);

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-async-storage/async-storage').default;
}

export const supabase = createClient(url, anon, {
  auth: {
    storage: getAuthStorage(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
