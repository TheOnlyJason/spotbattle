import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { theme } from '@/constants/theme';
import { ensureAnonSession } from '@/lib/auth';
import { generateRoomCode } from '@/lib/roomCode';
import { supabase } from '@/lib/supabase';
import type { RoomSettings, SongSource } from '@/lib/types';

const DEFAULT_SETTINGS: RoomSettings = {
  rounds: 10,
  songSource: 'playlists',
  secondsPerRound: 20,
  deepCuts: true,
  partyMode: false,
};

export default function CreateScreen() {
  const [nickname, setNickname] = useState('');
  const [rounds, setRounds] = useState(String(DEFAULT_SETTINGS.rounds));
  const [seconds, setSeconds] = useState(String(DEFAULT_SETTINGS.secondsPerRound));
  const [songSource, setSongSource] = useState<SongSource>('playlists');
  const [deepCuts, setDeepCuts] = useState(true);
  const [partyMode, setPartyMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onCreate() {
    setErr(null);
    const nick = nickname.trim();
    if (nick.length < 2) {
      setErr('Pick a nickname (2+ characters).');
      return;
    }
    const r = Math.min(20, Math.max(5, parseInt(rounds, 10) || DEFAULT_SETTINGS.rounds));
    const s = Math.min(30, Math.max(10, parseInt(seconds, 10) || DEFAULT_SETTINGS.secondsPerRound));
    setBusy(true);
    try {
      await ensureAnonSession();
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) throw new Error('No user');

      const settings: RoomSettings = {
        rounds: r,
        songSource,
        secondsPerRound: s,
        deepCuts,
        partyMode,
      };

      let code = generateRoomCode(4);
      for (let attempt = 0; attempt < 16; attempt++) {
        const { data: room, error: roomErr } = await supabase
          .from('rooms')
          .insert({
            code,
            host_user_id: uid,
            settings,
            status: 'lobby',
            phase: 'lobby',
          })
          .select('id')
          .single();
        if (!roomErr && room?.id) {
          const { error: pErr } = await supabase.from('room_players').insert({
            room_id: room.id,
            user_id: uid,
            nickname: nick,
            track_pool: [],
            ready: false,
          });
          if (pErr) {
            const hint =
              pErr.message?.includes('row-level security') || pErr.code === '42501'
                ? ' Check Supabase: run the migration SQL and enable Anonymous sign-in.'
                : '';
            throw new Error(`${pErr.message ?? 'Could not add you to the room.'}${hint}`);
          }
          router.replace(`/room/${code}`);
          return;
        }
        const duplicateCode =
          roomErr?.code === '23505' ||
          (roomErr?.message ?? '').toLowerCase().includes('duplicate') ||
          (roomErr?.message ?? '').toLowerCase().includes('unique');
        if (roomErr && !duplicateCode) {
          const msg = roomErr.message ?? roomErr.code ?? 'Room insert failed';
          const hint =
            msg.includes('relation') && msg.includes('does not exist')
              ? ' Run supabase/migrations/20260429170000_init.sql in the Supabase SQL Editor.'
              : msg.toLowerCase().includes('row-level security') || roomErr.code === '42501'
                ? ' Run the migration SQL and enable Authentication → Anonymous sign-ins.'
                : '';
          throw new Error(`${msg}${hint}`);
        }
        code = generateRoomCode(4);
      }
      throw new Error('Could not find a free room code — try again.');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.label}>Your nickname</Text>
      <TextInput
        style={styles.input}
        placeholder="DJ name"
        placeholderTextColor={theme.textMuted}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="words"
      />

      <Text style={styles.label}>Rounds (5–20)</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={rounds}
        onChangeText={setRounds}
        placeholderTextColor={theme.textMuted}
      />

      <Text style={styles.label}>Seconds per round (10–30)</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={seconds}
        onChangeText={setSeconds}
        placeholderTextColor={theme.textMuted}
      />

      <Text style={styles.label}>Song source</Text>
      <View style={styles.row}>
        <Pressable
          onPress={() => setSongSource('playlists')}
          style={[styles.chip, songSource === 'playlists' && styles.chipOn]}>
          <Text style={styles.chipText}>Playlists</Text>
        </Pressable>
        <Pressable
          onPress={() => setSongSource('liked')}
          style={[styles.chip, songSource === 'liked' && styles.chipOn]}>
          <Text style={styles.chipText}>Liked songs</Text>
        </Pressable>
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.label}>Deep cuts (unique songs only)</Text>
        <Switch value={deepCuts} onValueChange={setDeepCuts} trackColor={{ true: theme.accentDim }} />
      </View>

      <View style={styles.switchRow}>
        <View style={styles.switchLabelBlock}>
          <Text style={styles.label}>Party mode (one device plays audio)</Text>
          <Text style={styles.switchHint}>
            Other phones do not play the clip and do not show title, artist, or cover during guessing.
          </Text>
        </View>
        <Switch value={partyMode} onValueChange={setPartyMode} trackColor={{ true: theme.accentDim }} />
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      <Pressable style={styles.primary} onPress={onCreate} disabled={busy}>
        {busy ? <ActivityIndicator color="#04210f" /> : <Text style={styles.primaryText}>Create room</Text>}
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
    fontSize: 16,
    backgroundColor: theme.surface,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipOn: { borderColor: theme.accent, backgroundColor: theme.surface2 },
  chipText: { color: theme.text, fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    gap: 12,
  },
  switchLabelBlock: { flex: 1, minWidth: 0 },
  switchHint: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 },
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
