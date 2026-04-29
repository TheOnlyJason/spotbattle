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

export default function JoinScreen() {
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onJoin() {
    setErr(null);
    const c = code.trim().toUpperCase();
    const nick = nickname.trim();
    if (c.length < 4) {
      setErr('Enter a room code.');
      return;
    }
    if (nick.length < 2) {
      setErr('Pick a nickname (2+ characters).');
      return;
    }
    setBusy(true);
    try {
      await ensureAnonSession();
      const { error } = await supabase.rpc('join_room', { p_code: c, p_nickname: nick });
      if (error) {
        const msg = error.message ?? '';
        if (msg.includes('ROOM_NOT_FOUND')) setErr('Room not found or already started.');
        else setErr(msg);
        return;
      }
      router.replace(`/room/${c}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Join failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
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
      <Text style={styles.label}>Nickname</Text>
      <TextInput
        style={styles.input}
        placeholder="Your name"
        placeholderTextColor={theme.textMuted}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="words"
      />
      {err ? <Text style={styles.err}>{err}</Text> : null}
      <Pressable style={styles.primary} onPress={onJoin} disabled={busy}>
        {busy ? <ActivityIndicator color="#04210f" /> : <Text style={styles.primaryText}>Join</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 20, gap: 8 },
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
