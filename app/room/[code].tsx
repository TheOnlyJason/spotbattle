import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { TrackPreview } from '@/components/TrackPreview';
import { theme } from '@/constants/theme';
import { ensureAnonSession } from '@/lib/auth';
import {
  normalizePlayer,
  normalizeRoom,
  pickRandom,
  playableEntries,
} from '@/lib/gameLogic';
import { supabase } from '@/lib/supabase';
import {
  exchangeSpotifyCode,
  fetchAllPlaylistIds,
  fetchSavedTracks,
  fetchSpotifyProfile,
  fetchTracksFromPlaylists,
  getValidAccessToken,
  saveSpotifySession,
  spotifyRedirectUri,
  spotifyUsesDynamicRedirect,
  useSpotifyAuthRequest,
} from '@/lib/spotify';
import type { GameTrack, RoomPlayerRow, RoomRow } from '@/lib/types';
import { uniqueTracksPerPlayer } from '@/lib/uniquePool';

const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

async function applyScoringAndReveal(roomId: string) {
  const { data: cur } = await supabase
    .from('rooms')
    .select('phase, correct_player_id')
    .eq('id', roomId)
    .single();
  if (!cur?.correct_player_id || cur.phase !== 'guess') return;
  const correct = cur.correct_player_id as string;
  const { data: plist } = await supabase.from('room_players').select('*').eq('room_id', roomId);
  for (const row of plist ?? []) {
    const p = normalizePlayer(row as Record<string, unknown>);
    if (p.id === correct) continue;
    if (p.current_vote_player_id === correct) {
      await supabase.from('room_players').update({ score: p.score + 100 }).eq('id', p.id);
    }
  }
  await supabase.from('rooms').update({ phase: 'reveal' }).eq('id', roomId);
}

export default function RoomScreen() {
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const code = String(rawCode ?? '').toUpperCase();
  const router = useRouter();

  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<RoomPlayerRow[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const [authRequest, response, promptAsync] = useSpotifyAuthRequest(SPOTIFY_CLIENT_ID);

  const me = useMemo(
    () => players.find((p) => p.user_id === myUserId) ?? null,
    [players, myUserId]
  );
  const isHost = Boolean(room && myUserId && room.host_user_id === myUserId);

  const refreshLocal = useCallback(async () => {
    const { data: r } = await supabase.from('rooms').select('*').eq('code', code).maybeSingle();
    if (!r) {
      setLoadErr('Room not found.');
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
        const { data } = await supabase.auth.getUser();
        if (!cancelled) setMyUserId(data.user?.id ?? null);
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
      .channel(`room-${room.id}`)
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
    if (response?.type !== 'success' || !authRequest || !SPOTIFY_CLIENT_ID) return;
    const params = response.params as { code?: string };
    const c = params.code;
    const verifier = authRequest.codeVerifier;
    if (!c || !verifier) return;
    (async () => {
      try {
        const redirectUri = spotifyRedirectUri();
        const json = await exchangeSpotifyCode(SPOTIFY_CLIENT_ID, c, redirectUri, verifier);
        await saveSpotifySession(
          json.access_token!,
          json.refresh_token,
          json.expires_in ?? 3600
        );
        const token = await getValidAccessToken(SPOTIFY_CLIENT_ID);
        if (!token) return;
        const profile = await fetchSpotifyProfile(token);
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return;
        const { data: rrow } = await supabase.from('rooms').select('id').eq('code', code).maybeSingle();
        if (!rrow?.id) return;
        await supabase
          .from('room_players')
          .update({ spotify_display_name: profile.display_name ?? profile.id })
          .eq('room_id', rrow.id)
          .eq('user_id', uid);
        await refreshLocal();
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : 'Spotify login failed');
      }
    })();
  }, [response, authRequest, code, refreshLocal]);

  async function loadMyTracks() {
    if (!me?.id || !room) return;
    if (!SPOTIFY_CLIENT_ID) {
      setBusy('Set EXPO_PUBLIC_SPOTIFY_CLIENT_ID in .env');
      return;
    }
    setBusy('Fetching Spotify…');
    try {
      const token = await getValidAccessToken(SPOTIFY_CLIENT_ID);
      if (!token) {
        setBusy(null);
        setLoadErr('Connect Spotify first.');
        return;
      }
      let tracks: GameTrack[] = [];
      if (room.settings.songSource === 'liked') {
        tracks = await fetchSavedTracks(token);
      } else {
        const lists = await fetchAllPlaylistIds(token);
        const ids = lists.map((l) => l.id);
        tracks = await fetchTracksFromPlaylists(token, ids);
      }
      const { error } = await supabase.from('room_players').update({ track_pool: tracks }).eq('id', me.id);
      if (error) throw error;
      await refreshLocal();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleReady() {
    if (!me?.id) return;
    const { error } = await supabase.from('room_players').update({ ready: !me.ready }).eq('id', me.id);
    if (error) setLoadErr(error.message);
  }

  async function castVote(targetPlayerId: string) {
    if (!me?.id || !room || room.phase !== 'guess') return;
    if (targetPlayerId === room.correct_player_id) return;
    const { error } = await supabase
      .from('room_players')
      .update({ current_vote_player_id: targetPlayerId })
      .eq('id', me.id);
    if (error) setLoadErr(error.message);
  }

  const poolStats = useMemo(() => {
    const pools: Record<string, GameTrack[]> = {};
    for (const p of players) pools[p.id] = p.track_pool ?? [];
    const unique = uniqueTracksPerPlayer(pools);
    return players.map((p) => ({
      id: p.id,
      nick: p.nickname,
      total: (p.track_pool ?? []).length,
      unique: (unique[p.id] ?? []).length,
    }));
  }, [players]);

  async function clearVotes(roomId: string) {
    await supabase.from('room_players').update({ current_vote_player_id: null }).eq('room_id', roomId);
  }

  async function startGame() {
    if (!room || !isHost) return;
    if (players.length < 2) {
      setLoadErr('Need at least two players.');
      return;
    }
    const played = new Set<string>();
    const entries = playableEntries(players, room.settings, played);
    if (!entries.length) {
      setLoadErr('No playable tracks after filters. Add more distinct music or turn off Deep cuts.');
      return;
    }
    setBusy('Starting…');
    try {
      await clearVotes(room.id);
      const choice = pickRandom(entries);
      if (!choice) throw new Error('No track');
      const { error } = await supabase
        .from('rooms')
        .update({
          status: 'playing',
          phase: 'guess',
          round_number: 1,
          played_track_ids: [],
          current_track: choice.track,
          correct_player_id: choice.ownerPlayerId,
          round_started_at: new Date().toISOString(),
        })
        .eq('id', room.id);
      if (error) throw error;
      await refreshLocal();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setBusy(null);
    }
  }

  async function revealRound() {
    setBusy('Scoring…');
    try {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid) return;
      const { data: cur } = await supabase.from('rooms').select('*').eq('code', code).maybeSingle();
      if (!cur || cur.host_user_id !== uid || cur.phase !== 'guess') return;
      await applyScoringAndReveal(cur.id as string);
      await refreshLocal();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Reveal failed');
    } finally {
      setBusy(null);
    }
  }

  async function nextRound() {
    if (!room || !isHost) return;
    const trackId = room.current_track?.id;
    const played = [...(room.played_track_ids ?? []), ...(trackId ? [trackId] : [])];
    const nextNum = room.round_number + 1;
    if (nextNum > room.settings.rounds) {
      await supabase
        .from('rooms')
        .update({
          phase: 'ended',
          status: 'finished',
          played_track_ids: played,
          current_track: null,
          correct_player_id: null,
          round_started_at: null,
        })
        .eq('id', room.id);
      await refreshLocal();
      return;
    }
    await clearVotes(room.id);
    const { data: plist } = await supabase.from('room_players').select('*').eq('room_id', room.id);
    const freshPlayers = (plist ?? []).map((row) => normalizePlayer(row as Record<string, unknown>));
    const entries = playableEntries(freshPlayers, room.settings, new Set(played));
    if (!entries.length) {
      await supabase
        .from('rooms')
        .update({
          phase: 'ended',
          status: 'finished',
          round_number: nextNum,
          played_track_ids: played,
          current_track: null,
          correct_player_id: null,
        })
        .eq('id', room.id);
      await refreshLocal();
      return;
    }
    const choice = pickRandom(entries);
    if (!choice) return;
    await supabase
      .from('rooms')
      .update({
        phase: 'guess',
        round_number: nextNum,
        played_track_ids: played,
        current_track: choice.track,
        correct_player_id: choice.ownerPlayerId,
        round_started_at: new Date().toISOString(),
      })
      .eq('id', room.id);
    await refreshLocal();
  }

  useEffect(() => {
    if (room?.phase !== 'guess') return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [room?.phase]);

  const secondsLeft = useMemo(() => {
    if (!room?.round_started_at || room.phase !== 'guess') return null;
    const sec = room.settings.secondsPerRound;
    const end = new Date(room.round_started_at).getTime() + sec * 1000;
    return Math.max(0, Math.ceil((end - clock) / 1000));
  }, [room?.round_started_at, room?.phase, room?.settings.secondsPerRound, clock]);

  useEffect(() => {
    if (!isHost || !room || room.phase !== 'guess' || !room.round_started_at) return;
    const roomId = room.id;
    const sec = room.settings.secondsPerRound;
    const end = new Date(room.round_started_at).getTime() + sec * 1000;
    const t = setInterval(() => {
      if (Date.now() < end) return;
      clearInterval(t);
      void (async () => {
        const { data: u } = await supabase.auth.getUser();
        const uid = u.user?.id;
        if (!uid) return;
        const { data: cur } = await supabase
          .from('rooms')
          .select('host_user_id, phase, id')
          .eq('id', roomId)
          .single();
        if (!cur || cur.host_user_id !== uid || cur.phase !== 'guess') return;
        await applyScoringAndReveal(roomId);
        await refreshLocal();
      })();
    }, 500);
    return () => clearInterval(t);
  }, [isHost, room?.id, room?.phase, room?.round_started_at, room?.settings.secondsPerRound, refreshLocal]);

  if (loadErr && !room) {
    return (
      <View style={styles.center}>
        <Text style={styles.err}>{loadErr}</Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  if (!room) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  const correctPlayer = players.find((p) => p.id === room.correct_player_id);

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.codeLabel}>Room code</Text>
      <Text style={styles.code}>{room.code}</Text>
      {loadErr ? <Text style={styles.err}>{loadErr}</Text> : null}
      {busy ? <Text style={styles.busy}>{busy}</Text> : null}

      {room.phase === 'lobby' || room.status === 'lobby' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Lobby</Text>
          <Text style={styles.muted}>Share the code so friends can join, then connect Spotify and load tracks.</Text>
          {!SPOTIFY_CLIENT_ID ? (
            <Text style={styles.warn}>Add EXPO_PUBLIC_SPOTIFY_CLIENT_ID to use Spotify.</Text>
          ) : null}
          {SPOTIFY_CLIENT_ID && spotifyUsesDynamicRedirect() ? (
            <Text style={styles.redirectHint}>
              Add this exact Redirect URI in Spotify Dashboard → Settings:{'\n'}
              <Text style={styles.redirectMono}>{spotifyRedirectUri()}</Text>
            </Text>
          ) : SPOTIFY_CLIENT_ID ? (
            <Text style={styles.mutedSmall}>Spotify redirect: spotbattle://spotify-auth</Text>
          ) : null}
          <Pressable
            style={styles.secondary}
            onPress={() => promptAsync()}
            disabled={!authRequest}>
            <Text style={styles.secondaryText}>Log in with Spotify</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => void loadMyTracks()}>
            <Text style={styles.secondaryText}>
              Load my {room.settings.songSource === 'liked' ? 'liked songs' : 'playlists'} (previews only)
            </Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => void toggleReady()}>
            <Text style={styles.secondaryText}>{me?.ready ? 'Not ready' : 'Ready'}</Text>
          </Pressable>

          <Text style={styles.subTitle}>Players</Text>
          {players.map((p) => (
            <View key={p.id} style={styles.row}>
              <Text style={styles.rowText}>
                {p.nickname}
                {p.user_id === room.host_user_id ? ' (host)' : ''}
                {p.spotify_display_name ? ` · ${p.spotify_display_name}` : ''}
              </Text>
              <Text style={styles.mutedSmall}>
                {p.track_pool?.length ?? 0} tracks with preview
              </Text>
            </View>
          ))}

          <Text style={styles.subTitle}>Pool preview (Deep cuts counts)</Text>
          {poolStats.map((s) => (
            <Text key={s.id} style={styles.mutedSmall}>
              {s.nick}: {s.total} loaded · {s.unique} unique
            </Text>
          ))}

          {isHost ? (
            <Pressable style={styles.primary} onPress={() => void startGame()}>
              <Text style={styles.primaryText}>Start game</Text>
            </Pressable>
          ) : (
            <Text style={styles.muted}>Waiting for host to start…</Text>
          )}
        </View>
      ) : null}

      {room.phase === 'guess' && room.current_track ? (
        <View style={styles.card}>
          <TrackPreview
            uri={room.current_track.previewUrl}
            replayToken={`${room.round_number}-${room.current_track.id}`}
          />
          <Text style={styles.cardTitle}>Who owns this track?</Text>
          {secondsLeft !== null ? (
            <Text style={styles.timer}>{secondsLeft}s</Text>
          ) : null}
          {room.current_track.imageUrl ? (
            <Image source={{ uri: room.current_track.imageUrl }} style={styles.art} />
          ) : null}
          <Text style={styles.trackTitle}>{room.current_track.name}</Text>
          <Text style={styles.muted}>{room.current_track.artists}</Text>
          <Text style={styles.roundMeta}>
            Round {room.round_number} / {room.settings.rounds}
          </Text>
          <View style={styles.choices}>
            {players.map((p) => {
              const disabled = p.id === room.correct_player_id;
              const selected = me?.current_vote_player_id === p.id;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => void castVote(p.id)}
                  disabled={disabled || !me}
                  style={[
                    styles.choice,
                    disabled && styles.choiceDisabled,
                    selected && styles.choiceSelected,
                  ]}>
                  <Text style={styles.choiceText}>{p.nickname}</Text>
                </Pressable>
              );
            })}
          </View>
          {isHost ? (
            <Pressable style={styles.secondary} onPress={() => void revealRound()}>
              <Text style={styles.secondaryText}>Reveal now</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {room.phase === 'reveal' && room.current_track ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.trackTitle}>{room.current_track.name}</Text>
          <Text style={styles.answer}>Owner: {correctPlayer?.nickname ?? 'Unknown'}</Text>
          <Text style={styles.muted}>+100 for each correct guess (song owner excluded).</Text>
          {isHost ? (
            <Pressable style={styles.primary} onPress={() => void nextRound()}>
              <Text style={styles.primaryText}>Next round</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {(room.phase === 'ended' || room.status === 'finished') && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Final scores</Text>
          {[...players]
            .sort((a, b) => b.score - a.score)
            .map((p, i) => (
              <Text key={p.id} style={styles.scoreRow}>
                {i + 1}. {p.nickname} — {p.score} pts
              </Text>
            ))}
          <Pressable style={styles.secondary} onPress={() => router.replace('/')}>
            <Text style={styles.secondaryText}>Home</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scroll: { padding: 20, paddingBottom: 40, backgroundColor: theme.bg },
  codeLabel: { color: theme.textMuted, fontSize: 13 },
  code: { fontSize: 40, fontWeight: '900', color: theme.text, letterSpacing: 4, marginBottom: 12 },
  err: { color: theme.danger, marginBottom: 8 },
  busy: { color: theme.textMuted, marginBottom: 8 },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 10,
  },
  cardTitle: { fontSize: 20, fontWeight: '800', color: theme.text },
  muted: { color: theme.textMuted, fontSize: 14, lineHeight: 20 },
  warn: { color: theme.danger, fontSize: 13 },
  subTitle: { marginTop: 8, fontSize: 15, fontWeight: '700', color: theme.text },
  row: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  rowText: { color: theme.text, fontSize: 15 },
  mutedSmall: { color: theme.textMuted, fontSize: 13 },
  primary: {
    marginTop: 8,
    backgroundColor: theme.accent,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryText: { color: '#04210f', fontWeight: '800', fontSize: 16 },
  secondary: {
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: theme.surface2,
  },
  secondaryText: { color: theme.text, fontWeight: '600' },
  btn: { marginTop: 16, padding: 14, backgroundColor: theme.surface2, borderRadius: 12 },
  btnText: { color: theme.text },
  art: { width: '100%', aspectRatio: 1, borderRadius: 12, marginTop: 8 },
  trackTitle: { fontSize: 22, fontWeight: '800', color: theme.text, marginTop: 8 },
  timer: { fontSize: 28, fontWeight: '900', color: theme.accent },
  roundMeta: { color: theme.textMuted },
  choices: { gap: 8, marginTop: 8 },
  choice: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.surface2,
    borderWidth: 1,
    borderColor: theme.border,
  },
  choiceDisabled: { opacity: 0.35 },
  choiceSelected: { borderColor: theme.accent },
  choiceText: { color: theme.text, fontSize: 16, fontWeight: '700' },
  answer: { fontSize: 18, fontWeight: '700', color: theme.accent, marginTop: 6 },
  scoreRow: { color: theme.text, fontSize: 16, paddingVertical: 4 },
  redirectHint: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  redirectMono: {
    fontFamily: 'SpaceMono',
    color: theme.accent,
    fontSize: 11,
  },
});
