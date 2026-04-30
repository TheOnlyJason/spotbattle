import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TrackPreview } from '@/components/TrackPreview';
import { theme } from '@/constants/theme';
import { ensureAnonSession } from '@/lib/auth';
import { enrichTracksWithDeezerPreviews } from '@/lib/deezerPreview';
import {
  normalizePlayer,
  normalizeRoom,
  pickRandom,
  playableEntries,
  shuffleInPlace,
  STALE_TRACK_POOL_MAX,
  trackPoolFetchSampleTarget,
  trackPoolSampleTarget,
} from '@/lib/gameLogic';
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
import { supabase } from '@/lib/supabase';
import type { GameTrack, RoomPlayerRow, RoomRow } from '@/lib/types';
import { uniqueTracksPerPlayer } from '@/lib/uniquePool';

const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '';
/** Must match `advance_from_reveal` dwell in Supabase migration. */
const REVEAL_DWELL_MS = 3000;

export default function RoomScreen() {
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const code = String(rawCode ?? '').toUpperCase();
  const router = useRouter();

  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<RoomPlayerRow[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [trackNotice, setTrackNotice] = useState<string | null>(null);
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
    if (!room) {
      setLoadErr('Room not loaded yet.');
      return;
    }
    if (!me?.id) {
      setLoadErr(
        'Your seat in this room is not ready yet. Wait a few seconds, reopen the room, or leave and rejoin with the code — then tap Load again.'
      );
      return;
    }
    if (!SPOTIFY_CLIENT_ID) {
      setBusy('Set EXPO_PUBLIC_SPOTIFY_CLIENT_ID in .env');
      return;
    }
    setLoadErr(null);
    setTrackNotice(null);
    setBusy('Fetching Spotify…');
    try {
      const token = await getValidAccessToken(SPOTIFY_CLIENT_ID);
      if (!token) {
        setBusy(null);
        setLoadErr('Connect Spotify first.');
        return;
      }
      const poolTarget = trackPoolSampleTarget(room.settings.rounds, room.settings.deepCuts);
      const fetchSize = trackPoolFetchSampleTarget(poolTarget);
      let tracks: GameTrack[] = [];
      if (room.settings.songSource === 'liked') {
        setBusy(`Loading liked songs (sampling ${fetchSize} for previews)…`);
        tracks = await fetchSavedTracks(token, { sampleTarget: fetchSize });
      } else {
        setBusy('Loading your playlists…');
        const lists = await fetchAllPlaylistIds(token);
        const ids = lists.map((l) => l.id);
        setBusy(`Loading tracks from playlists (sampling ${fetchSize} for previews)…`);
        tracks = await fetchTracksFromPlaylists(token, ids, { sampleTarget: fetchSize });
      }
      setBusy('Looking up preview audio (Deezer by ISRC)…');
      tracks = await enrichTracksWithDeezerPreviews(tracks);
      const withPreview = tracks.filter((t) => Boolean(t.previewUrl));
      shuffleInPlace(withPreview);
      tracks = withPreview.slice(0, poolTarget);
      const { error } = await supabase.from('room_players').update({ track_pool: tracks }).eq('id', me.id);
      if (error) throw error;
      await refreshLocal();
      if (tracks.length === 0) {
        const webHint =
          Platform.OS === 'web'
            ? ' On web, set EXPO_PUBLIC_DEEZER_PREVIEW_PROXY_URL or use a deployed build with /api/deezer-preview.'
            : '';
        setLoadErr(
          `No previewable tracks in this sample (${fetchSize} tried). Try different playlists, Liked songs, or reload.${webHint}`
        );
      } else if (tracks.length < poolTarget) {
        setTrackNotice(
          `${tracks.length} previewable tracks saved (wanted up to ${poolTarget} — try more playlists or run “Load” again).`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fetch failed';
      const hint =
        msg.includes('Failed to fetch') || msg.includes('Network request failed')
          ? ' Check your network. On web, ad blockers or strict privacy settings can block Spotify’s API.'
          : '';
      setLoadErr(`${msg}${hint}`);
    } finally {
      setBusy(null);
    }
  }

  async function toggleReady() {
    if (!me?.id) {
      setLoadErr('Your seat in this room is not ready yet. Wait or rejoin, then try Ready again.');
      return;
    }
    const { error } = await supabase.from('room_players').update({ ready: !me.ready }).eq('id', me.id);
    if (error) setLoadErr(error.message);
  }

  async function castVote(targetPlayerId: string) {
    if (!me?.id || !room || room.phase !== 'guess') return;
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
    for (const p of players) {
      const pool = p.track_pool ?? [];
      if (pool.length === 0) {
        setLoadErr(
          `${p.nickname} has not loaded tracks yet. They should connect Spotify and tap Load my ${room.settings.songSource === 'liked' ? 'liked songs' : 'playlists'}.`
        );
        return;
      }
      if (pool.length > STALE_TRACK_POOL_MAX) {
        setLoadErr(
          `${p.nickname} still has a large old track list (${pool.length} tracks). They must tap “Load my ${room.settings.songSource === 'liked' ? 'liked songs' : 'playlists'}” on their device once to rebuild a small preview-only pool.`
        );
        return;
      }
      if (pool.length > 0) {
        const prev = pool.filter((t) => Boolean(t.previewUrl)).length;
        if (prev === 0) {
          setLoadErr(
            `${p.nickname} has no previewable tracks. They should connect Spotify, tap Load, and on web set the Deezer proxy (see README).`
          );
          return;
        }
        if (prev < pool.length) {
          setLoadErr(
            `${p.nickname} still has songs without previews. They should tap Load again so the pool is preview-only.`
          );
          return;
        }
      }
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
          reveal_started_at: null,
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
        const { error } = await supabase.rpc('advance_from_reveal', { p_room_id: roomId });
        if (error) setLoadErr(error.message);
        await refreshLocal();
      })();
    }, delay);
    return () => clearTimeout(tid);
  }, [room?.id, room?.phase, room?.reveal_started_at, refreshLocal]);

  const insets = useSafeAreaInsets();
  const { height: winH, width: winW } = useWindowDimensions();
  const artSize = Math.min(winW - 32, Math.max(120, winH * 0.22));

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
  const inGuess = room.phase === 'guess' && Boolean(room.current_track);

  return (
    <View
      style={[
        styles.screenRoot,
        { flex: 1, backgroundColor: theme.bg, paddingTop: insets.top },
      ]}>
      {inGuess ? (
        <View style={styles.guessScreen}>
          <View style={styles.guessHeaderRow}>
            <View>
              <Text style={styles.codeLabel}>Room</Text>
              <Text style={styles.codeCompact}>{room.code}</Text>
            </View>
            {secondsLeft !== null ? <Text style={styles.timerHeader}>{secondsLeft}s</Text> : null}
          </View>
          {loadErr ? <Text style={styles.err}>{loadErr}</Text> : null}
          {trackNotice ? <Text style={styles.trackNotice}>{trackNotice}</Text> : null}
          {busy ? <Text style={styles.busy}>{busy}</Text> : null}
          <View style={[styles.guessFill, { paddingBottom: insets.bottom + 10 }]}>
            <View style={styles.guessTop}>
              <TrackPreview
                uri={room.current_track!.previewUrl}
                replayToken={`${room.round_number}-${room.current_track!.id}`}
              />
              {!room.current_track!.previewUrl ? (
                <Text style={styles.previewNoteGuess}>
                  No preview clip — guess from title & artist.
                </Text>
              ) : null}
              <Text style={styles.guessCardTitle}>Who owns this track?</Text>
              {room.current_track!.imageUrl ? (
                <Image
                  source={{ uri: room.current_track!.imageUrl }}
                  style={[styles.artGuess, { width: artSize, height: artSize }]}
                />
              ) : null}
              <Text style={styles.trackTitleGuess} numberOfLines={2}>
                {room.current_track!.name}
              </Text>
              <Text style={styles.mutedGuess} numberOfLines={1}>
                {room.current_track!.artists}
              </Text>
              <Text style={styles.roundMetaGuess}>
                Round {room.round_number} / {room.settings.rounds}
              </Text>
            </View>
            <View style={styles.guessBottom}>
              <View style={styles.choicesGrid}>
                {players.map((p) => {
                  const selected = me?.current_vote_player_id === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => void castVote(p.id)}
                      disabled={!me}
                      style={[
                        styles.choiceGuess,
                        selected && styles.choiceSelected,
                        players.length > 3 ? styles.choiceGuessNarrow : null,
                      ]}>
                      <Text style={styles.choiceTextGuess} numberOfLines={1}>
                        {p.nickname}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollFlex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.codeLabel}>Room code</Text>
          <Text style={styles.code}>{room.code}</Text>
          {loadErr ? <Text style={styles.err}>{loadErr}</Text> : null}
          {trackNotice ? <Text style={styles.trackNotice}>{trackNotice}</Text> : null}
          {busy ? <Text style={styles.busy}>{busy}</Text> : null}

          {room.phase === 'lobby' || room.status === 'lobby' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Lobby</Text>
          <Text style={styles.muted}>
            Share the code so friends can join. Everyone logs into Spotify and taps Load my playlists on their own
            phone — each person builds their own small preview-only pool (large old lists stay in the database until
            they load again).
          </Text>
          {!SPOTIFY_CLIENT_ID ? (
            <Text style={styles.warn}>Add EXPO_PUBLIC_SPOTIFY_CLIENT_ID to use Spotify.</Text>
          ) : null}
          {SPOTIFY_CLIENT_ID && spotifyUsesDynamicRedirect() ? (
            <>
              <Text style={styles.redirectHint}>
                Add this exact Redirect URI in Spotify Dashboard → Settings:{'\n'}
                <Text style={styles.redirectMono}>{spotifyRedirectUri()}</Text>
              </Text>
              {typeof window !== 'undefined' && window.location?.hostname === 'localhost' ? (
                <Text style={styles.warn}>
                  Open this app at 127.0.0.1 (same port), not localhost — otherwise the Spotify
                  popup cannot complete sign-in.
                </Text>
              ) : null}
            </>
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
                {(() => {
                  const pool = p.track_pool ?? [];
                  const n = pool.length;
                  const prev = pool.filter((t) => t.previewUrl).length;
                  if (n === 0) return '0 tracks';
                  return `${n} track${n === 1 ? '' : 's'} · ${prev} with preview audio`;
                })()}
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

      {room.phase === 'reveal' && room.current_track ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.trackTitle}>{room.current_track.name}</Text>
          <Text style={styles.answer}>Owner: {correctPlayer?.nickname ?? 'Unknown'}</Text>
          <Text style={styles.muted}>+100 for each correct guess.</Text>
          {revealSecondsLeft !== null ? (
            <Text style={styles.revealCountdown}>Next round in {revealSecondsLeft}s…</Text>
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screenRoot: { minHeight: 0 },
  guessScreen: { flex: 1, minHeight: 0, paddingHorizontal: 16 },
  guessHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  codeCompact: { fontSize: 22, fontWeight: '900', color: theme.text, letterSpacing: 3 },
  timerHeader: { fontSize: 22, fontWeight: '900', color: theme.accent },
  guessFill: { flex: 1, minHeight: 0, justifyContent: 'space-between' },
  guessTop: { flexShrink: 1, alignItems: 'center', width: '100%', gap: 4 },
  guessBottom: { width: '100%', gap: 8, flexShrink: 0, paddingTop: 4 },
  guessCardTitle: { fontSize: 16, fontWeight: '800', color: theme.text, marginTop: 2 },
  artGuess: { borderRadius: 12, marginTop: 2 },
  trackTitleGuess: {
    fontSize: 17,
    fontWeight: '800',
    color: theme.text,
    textAlign: 'center',
    width: '100%',
    paddingHorizontal: 4,
  },
  mutedGuess: { color: theme.textMuted, fontSize: 13, textAlign: 'center', width: '100%' },
  roundMetaGuess: { color: theme.textMuted, fontSize: 12 },
  previewNoteGuess: {
    color: theme.accent,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
  choicesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },
  choiceGuess: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: '42%',
    maxWidth: '100%',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: theme.surface2,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  choiceGuessNarrow: {
    flexBasis: '30%',
    minWidth: '28%',
    paddingVertical: 9,
    paddingHorizontal: 6,
  },
  choiceTextGuess: { color: theme.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  secondaryGuess: {
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: theme.surface2,
    marginTop: 4,
  },
  center: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scroll: { padding: 20, paddingBottom: 40, backgroundColor: theme.bg },
  scrollFlex: { flex: 1 },
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
  previewNote: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
  },
  trackNotice: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
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
  choiceSelected: { borderColor: theme.accent },
  choiceText: { color: theme.text, fontSize: 16, fontWeight: '700' },
  answer: { fontSize: 18, fontWeight: '700', color: theme.accent, marginTop: 6 },
  revealCountdown: { fontSize: 16, fontWeight: '800', color: theme.text, marginTop: 8 },
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
