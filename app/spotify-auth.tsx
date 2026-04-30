import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { theme } from '@/constants/theme';

/**
 * Spotify OAuth redirect lands here (e.g. `http://127.0.0.1:8081/spotify-auth?code=...`).
 * On web, `maybeCompleteAuthSession` posts the URL back to the opener and closes the popup.
 */
export default function SpotifyAuthCallbackScreen() {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setNote('You can close this screen and go back to the room.');
      const t = setTimeout(() => router.replace('/'), 2000);
      return () => clearTimeout(t);
    }
    try {
      let result = WebBrowser.maybeCompleteAuthSession();
      if (
        result.type === 'failed' &&
        typeof result.message === 'string' &&
        result.message.includes('do not match')
      ) {
        result = WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
      }
      if (result.type === 'failed') {
        const msg = result.message ?? '';
        setNote(
          msg.includes('No auth session')
            ? 'Sign-in could not finish. Open the app at http://127.0.0.1:PORT (not localhost), then try Log in with Spotify again.'
            : msg || 'Could not complete sign-in.'
        );
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Sign-in failed');
    }
  }, [router]);

  return (
    <>
      <Stack.Screen options={{ title: 'Spotify', headerShown: true }} />
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} size="large" />
        {!note ? (
          <Text style={styles.text}>Completing sign-in…</Text>
        ) : (
          <Text style={styles.note}>{note}</Text>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: theme.bg,
  },
  text: { marginTop: 16, color: theme.text },
  note: { marginTop: 16, color: theme.textMuted, textAlign: 'center' },
});
