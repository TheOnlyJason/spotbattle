import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/constants/theme';
import { isSupabaseConfigured } from '@/lib/supabase';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}>
      <Text style={styles.logo}>spotBattle</Text>
      <Text style={styles.tagline}>Who likes this song?</Text>
      {!isSupabaseConfigured ? (
        <Text style={styles.warn}>
          Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to a `.env` file (see
          README).
        </Text>
      ) : null}
      <View style={styles.spacer} />
      <View style={styles.actions}>
        <Link href="/create" asChild disabled={!isSupabaseConfigured}>
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              (!isSupabaseConfigured || pressed) && { opacity: 0.85 },
            ]}>
            <Text style={styles.primaryLabel}>Create game</Text>
          </Pressable>
        </Link>
        <Link href="/join" asChild disabled={!isSupabaseConfigured}>
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              (!isSupabaseConfigured || pressed) && { opacity: 0.85 },
            ]}>
            <Text style={styles.secondaryLabel}>Join game</Text>
          </Pressable>
        </Link>
      </View>
      <Text style={styles.hint}>Connect Spotify in the room. Party play, music-first.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    paddingHorizontal: 24,
  },
  logo: {
    fontSize: 36,
    fontWeight: '800',
    color: theme.text,
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 8,
    fontSize: 17,
    color: theme.textMuted,
  },
  warn: {
    marginTop: 20,
    color: theme.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  spacer: { flex: 1, minHeight: 24 },
  actions: {
    gap: 14,
  },
  primaryBtn: {
    backgroundColor: theme.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryLabel: {
    color: '#04210f',
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    backgroundColor: theme.surface,
  },
  secondaryLabel: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '600',
  },
  hint: {
    marginTop: 28,
    fontSize: 13,
    color: theme.textMuted,
    lineHeight: 18,
  },
});
