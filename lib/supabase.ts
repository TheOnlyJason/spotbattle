import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

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
 * AsyncStorage's web implementation uses `window`. That throws during `expo export`
 * (static web) and other Node-side evaluation. Use memory storage only in that case.
 */
function getAuthStorage() {
  if (Platform.OS === 'web' && typeof window === 'undefined') {
    return createMemoryAuthStorage();
  }
  return AsyncStorage;
}

export const supabase = createClient(url, anon, {
  auth: {
    storage: getAuthStorage(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
