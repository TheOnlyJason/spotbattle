import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/constants/theme';
import { isSupabaseConfigured } from '@/lib/supabase';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 16,
        },
      ]}>
      <View style={styles.column}>
        <Text style={styles.logo}>spotBattle</Text>
        <Text style={styles.tagline}>Who likes this song?</Text>
        {!isSupabaseConfigured ? (
          <Text style={styles.warn}>
            Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to a `.env` file (see
            README).
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !isSupabaseConfigured }}
            onPress={() => {
              if (isSupabaseConfigured) router.push('/create');
            }}
            style={({ pressed }) => [
              styles.primaryBtn,
              !isSupabaseConfigured && styles.primaryBtnInactive,
              pressed && isSupabaseConfigured && styles.primaryBtnPressed,
            ]}>
            <Text
              style={[
                styles.primaryLabel,
                !isSupabaseConfigured && styles.primaryLabelInactive,
              ]}>
              Create game
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !isSupabaseConfigured }}
            onPress={() => {
              if (isSupabaseConfigured) router.push('/join');
            }}
            style={({ pressed }) => [
              styles.secondaryBtn,
              !isSupabaseConfigured && styles.secondaryBtnInactive,
              pressed && isSupabaseConfigured && styles.secondaryBtnPressed,
            ]}>
            <Text
              style={[
                styles.secondaryLabel,
                !isSupabaseConfigured && styles.secondaryLabelInactive,
              ]}>
              Join game
            </Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Connect Spotify in the room. Party play, music-first.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  column: {
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  logo: {
    fontSize: 36,
    fontWeight: '800',
    color: theme.text,
    letterSpacing: -0.5,
    textAlign: 'center',
    width: '100%',
  },
  tagline: {
    marginTop: 8,
    fontSize: 17,
    color: theme.textMuted,
    textAlign: 'center',
    width: '100%',
  },
  warn: {
    marginTop: 20,
    color: theme.danger,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    width: '100%',
  },
  actions: {
    width: '100%',
    gap: 14,
    marginTop: 36,
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: theme.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryBtnPressed: {
    backgroundColor: theme.accentDim,
  },
  primaryBtnInactive: {
    backgroundColor: '#166b35',
    opacity: 0.85,
  },
  primaryLabel: {
    color: '#f4fff7',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.15,
  },
  primaryLabelInactive: {
    color: 'rgba(244, 244, 248, 0.92)',
  },
  secondaryBtn: {
    width: '100%',
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    backgroundColor: theme.surface,
  },
  secondaryBtnPressed: {
    backgroundColor: theme.surface2,
    borderColor: '#3d4358',
  },
  secondaryBtnInactive: {
    opacity: 0.55,
  },
  secondaryLabel: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryLabelInactive: {
    color: theme.textMuted,
  },
  hint: {
    marginTop: 28,
    fontSize: 13,
    color: theme.textMuted,
    lineHeight: 18,
    textAlign: 'center',
    width: '100%',
  },
});
