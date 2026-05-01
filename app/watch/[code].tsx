import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/constants/theme';
import { ensureAnonSession } from '@/lib/auth';
import { normalizePlayer, normalizeRoom } from '@/lib/gameLogic';
import { supabase } from '@/lib/supabase';
import type { RoomPlayerRow, RoomRow } from '@/lib/types';
import { watchUrlForCode } from '@/lib/watchUrl';

const REVEAL_DWELL_MS = 3000;

export default function WatchScreen() {
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const code = String(rawCode ?? '').toUpperCase();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<RoomPlayerRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const contesters = useMemo(() => players.filter((p) => !p.is_spectator), [players]);
  const spectators = useMemo(() => players.filter((p) => p.is_spectator), [players]);

  const refreshLocal = useCallback(async () => {
    const { data: r } = await supabase.from('rooms').select('*').eq('code', code).maybeSingle();
    if (!r) {
      setLoadErr('Room not found or the host closed the party.');
      return;
    }
    setLoadErr(null);
    setRoom(normalizeRoom(r as Record<string, unknown>));
    const { data: plist } = await supabase
      .from('room_players')
      .select('*')
      .eq('room_id', r.id)
      .order('created_at', { ascending: true });
    setPlayers((plist ?? []).map((row) => normalizePlayer(row as Record<string, unknown>)));
  }, [code]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureAnonSession();
        await refreshLocal();
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : 'Load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshLocal]);

  useEffect(() => {
    if (!room?.id) return;
    const ch = supabase
      .channel(`watch-room-${room.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` },
        () => {
          void refreshLocal();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${room.id}` },
        () => {
          void refreshLocal();
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [room?.id, refreshLocal]);

  useEffect(() => {
    if (room?.phase !== 'guess' && room?.phase !== 'reveal') return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [room?.phase]);

  const secondsLeft = useMemo(() => {
    if (!room?.round_started_at || room.phase !== 'guess') return null;
    const sec = room.settings.secondsPerRound;
    const end = new Date(room.round_started_at).getTime() + sec * 1000;
    return Math.max(0, Math.ceil((end - clock) / 1000));
  }, [room?.round_started_at, room?.phase, room?.settings.secondsPerRound, clock]);

  const revealSecondsLeft = useMemo(() => {
    if (!room?.reveal_started_at || room.phase !== 'reveal') return null;
    const end = new Date(room.reveal_started_at).getTime() + REVEAL_DWELL_MS;
    return Math.max(0, Math.ceil((end - clock) / 1000));
  }, [room?.reveal_started_at, room?.phase, clock]);

  useEffect(() => {
    if (!room || room.phase !== 'guess' || !room.round_started_at) return;
    const roomId = room.id;
    const sec = room.settings.secondsPerRound;
    const end = new Date(room.round_started_at).getTime() + sec * 1000;
    const t = setInterval(() => {
      if (Date.now() < end) return;
      clearInterval(t);
      void (async () => {
        try {
          await ensureAnonSession();
        } catch (e) {
          setLoadErr(e instanceof Error ? e.message : 'Session lost');
          return;
        }
        const { error } = await supabase.rpc('finalize_guess_phase', { p_room_id: roomId });
        if (error) setLoadErr(error.message);
        await refreshLocal();
      })();
    }, 500);
    return () => clearInterval(t);
  }, [room?.id, room?.phase, room?.round_started_at, room?.settings.secondsPerRound, refreshLocal]);

  useEffect(() => {
    if (!room || room.phase !== 'reveal' || !room.reveal_started_at) return;
    const roomId = room.id;
    const fireAt = new Date(room.reveal_started_at).getTime() + REVEAL_DWELL_MS;
    const delay = Math.max(0, fireAt - Date.now());
    const tid = setTimeout(() => {
      void (async () => {
        try {
          await ensureAnonSession();
        } catch (e) {
          setLoadErr(e instanceof Error ? e.message : 'Session lost');
          return;
        }
        const { error } = await supabase.rpc('advance_from_reveal', { p_room_id: roomId });
        if (error) setLoadErr(error.message);
        await refreshLocal();
      })();
    }, delay);
    return () => clearTimeout(tid);
  }, [room?.id, room?.phase, room?.reveal_started_at, refreshLocal]);

  if (loadErr && !room) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.err}>{loadErr}</Text>
        <Pressable style={styles.btn} onPress={() => router.replace('/')}>
          <Text style={styles.btnText}>Home</Text>
        </Pressable>
      </View>
    );
  }

  if (!room) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  const correctPlayer = players.find((p) => p.id === room.correct_player_id);
  const scoreRows = [...contesters].sort((a, b) => b.score - a.score);

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.bg, paddingTop: insets.top + 12 }]}
      contentContainerStyle={[styles.scrollInner, { paddingBottom: insets.bottom + 24 }]}>
      <Text style={styles.kicker}>Stream view</Text>
      <Text style={styles.code}>{room.code}</Text>
      <Text style={styles.urlLine} selectable>
        {watchUrlForCode(room.code)}
      </Text>
      {loadErr ? <Text style={styles.err}>{loadErr}</Text> : null}

      {(room.phase === 'lobby' || room.status === 'lobby' || room.phase === 'building') && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Lobby</Text>
          <Text style={styles.muted}>
            Players join on their phones. When the host starts, this screen will show timers and scores — not the
            secret answers during guessing.
          </Text>
          <Text style={styles.subTitle}>Players</Text>
          {contesters.map((p) => (
            <Text key={p.id} style={styles.rowText}>
              {p.nickname}
              {p.user_id === room.host_user_id ? ' · host' : ''}
              {p.ready ? ' · ready' : ''}
            </Text>
          ))}
          {spectators.length > 0 ? (
            <>
              <Text style={styles.subTitle}>Watching</Text>
              {spectators.map((p) => (
                <Text key={p.id} style={styles.mutedSmall}>
                  {p.nickname}
                </Text>
              ))}
            </>
          ) : null}
        </View>
      )}

      {room.phase === 'guess' && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Round {room.round_number}</Text>
          {secondsLeft !== null ? <Text style={styles.timer}>{secondsLeft}s</Text> : null}
          <Text style={styles.hugeMuted}>Mystery track</Text>
          <Text style={styles.muted}>
            Answers stay on each player phone. When time runs out, the reveal will show here automatically.
          </Text>
          <Text style={styles.subTitle}>Scores</Text>
          {scoreRows.map((p, i) => (
            <Text key={p.id} style={styles.rowText}>
              {i + 1}. {p.nickname} — {p.score} pts
            </Text>
          ))}
        </View>
      )}

      {room.phase === 'reveal' && room.current_track ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.trackTitle}>{room.current_track.name}</Text>
          <Text style={styles.muted}>{room.current_track.artists}</Text>
          <Text style={styles.answer}>Owner: {correctPlayer?.nickname ?? 'Unknown'}</Text>
          {revealSecondsLeft !== null ? (
            <Text style={styles.revealNext}>Next round in {revealSecondsLeft}s…</Text>
          ) : null}
        </View>
      ) : null}

      {(room.phase === 'ended' || room.status === 'finished') && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Match over</Text>
          {scoreRows.map((p, i) => (
            <Text key={p.id} style={styles.rowText}>
              {i + 1}. {p.nickname} — {p.score} pts
            </Text>
          ))}
          <Text style={styles.muted}>
            The party stays open until the host leaves or sends everyone back to the lobby for another game.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: theme.bg },
  scroll: { flex: 1 },
  scrollInner: { paddingHorizontal: 20, gap: 16 },
  kicker: { color: theme.textMuted, fontSize: 14, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  code: { fontSize: 48, fontWeight: '900', color: theme.text, letterSpacing: 6 },
  urlLine: { color: theme.accent, fontSize: 13, lineHeight: 18 },
  err: { color: theme.danger, fontSize: 14 },
  btn: { marginTop: 16, padding: 14, backgroundColor: theme.surface2, borderRadius: 12 },
  btnText: { color: theme.text },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 10,
  },
  cardTitle: { fontSize: 22, fontWeight: '800', color: theme.text },
  muted: { color: theme.textMuted, fontSize: 15, lineHeight: 22 },
  mutedSmall: { color: theme.textMuted, fontSize: 14 },
  subTitle: { marginTop: 8, fontSize: 16, fontWeight: '700', color: theme.text },
  rowText: { color: theme.text, fontSize: 17, paddingVertical: 4 },
  timer: { fontSize: 56, fontWeight: '900', color: theme.accent, textAlign: 'center' },
  hugeMuted: {
    fontSize: 28,
    fontWeight: '800',
    color: theme.textMuted,
    textAlign: 'center',
    marginVertical: 8,
  },
  trackTitle: { fontSize: 24, fontWeight: '800', color: theme.text },
  answer: { fontSize: 20, fontWeight: '700', color: theme.accent, marginTop: 8 },
  revealNext: { fontSize: 16, fontWeight: '700', color: theme.text, marginTop: 8 },
});
