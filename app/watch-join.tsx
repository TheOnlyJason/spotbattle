import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { theme } from '@/constants/theme';
import { ensureAnonSession } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { watchUrlForCode } from '@/lib/watchUrl';

export default function WatchJoinScreen() {
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onWatch() {
    setErr(null);
    const c = code.trim().toUpperCase();
    const nick = nickname.trim();
    if (c.length < 4) {
      setErr('Enter a room code.');
      return;
    }
    if (nick.length < 2) {
      setErr('Pick a display name (2+ characters).');
      return;
    }
    setBusy(true);
    try {
      await ensureAnonSession();
      const { error } = await supabase.rpc('join_room_spectator', { p_code: c, p_nickname: nick });
      if (error) {
        const msg = error.message ?? '';
        if (msg.includes('ROOM_NOT_FOUND')) setErr('Room not found.');
        else setErr(msg);
        return;
      }
      router.replace(`/watch/${c}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not join as audience');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.lead}>
        For Discord or a TV stream: this view never shows who guessed what or the answer during a round — only
        scores and timers. Players use “Join game” on their phones.
      </Text>
      <Text style={styles.label}>Room code</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. X7K9"
        placeholderTextColor={theme.textMuted}
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        autoCapitalize="characters"
        maxLength={6}
      />
      <Text style={styles.label}>Your name (shown in the lobby)</Text>
      <TextInput
        style={styles.input}
        placeholder="Audience"
        placeholderTextColor={theme.textMuted}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="words"
      />
      {typeof window !== 'undefined' && code.trim().length >= 4 ? (
        <Text style={styles.hint}>After joining, bookmark: {watchUrlForCode(code.trim())}</Text>
      ) : null}
      {err ? <Text style={styles.err}>{err}</Text> : null}
      <Pressable style={styles.primary} onPress={onWatch} disabled={busy}>
        {busy ? <ActivityIndicator color="#04210f" /> : <Text style={styles.primaryText}>Open stream view</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 20, gap: 8 },
  lead: { color: theme.textMuted, fontSize: 14, lineHeight: 21, marginBottom: 8 },
  label: { color: theme.textMuted, fontSize: 13, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 18,
    letterSpacing: 2,
    backgroundColor: theme.surface,
  },
  hint: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  err: { color: theme.danger, marginTop: 8 },
  primary: {
    marginTop: 24,
    backgroundColor: theme.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#04210f', fontWeight: '800', fontSize: 16 },
});
