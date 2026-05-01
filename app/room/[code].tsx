import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfettiCelebration } from '@/components/ConfettiCelebration';
import { TrackPreview } from '@/components/TrackPreview';
import { theme } from '@/constants/theme';
import { ensureAnonSession } from '@/lib/auth';
import { enrichTracksWithDeezerPreviews } from '@/lib/deezerPreview';
import {
  mergePersistedRoomSettings,
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
  hasSpotifySession,
  LIKED_SONGS_SOURCE_NAME,
  pickSpotifyProfileImageUrl,
  saveSpotifySession,
  spotifyRedirectUri,
  useSpotifyAuthRequest,
} from '@/lib/spotify';
import { supabase } from '@/lib/supabase';
import type { GameTrack, RoomPlayerRow, RoomRow, SongSource } from '@/lib/types';
import { partyDeckAbsoluteUrlForCode, partyDeckUrlForCode } from '../../lib/partyDeckUrl';
import { getMockTrackPoolForUi, UI_DEV_SKIP_SPOTIFY } from '@/lib/uiDevMode';

const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '';
/** Must match `advance_from_reveal` dwell in Supabase migration. */
const REVEAL_DWELL_MS = 3000;

/** High-contrast quiz-style tiles for guess voting (cycles by player order). */
type GuessQuizPalette = { bg: string; border: string; fg: string };

const GUESS_PLAYER_PALETTE: GuessQuizPalette[] = [
  { bg: '#1d4ed8', border: '#3b82f6', fg: '#ffffff' },
  { bg: '#b91c1c', border: '#f87171', fg: '#ffffff' },
  { bg: '#047857', border: '#34d399', fg: '#ffffff' },
  { bg: '#b45309', border: '#fbbf24', fg: '#fffbeb' },
  { bg: '#6d28d9', border: '#c084fc', fg: '#ffffff' },
  { bg: '#9d174d', border: '#f472b6', fg: '#ffffff' },
  { bg: '#0e7490', border: '#22d3ee', fg: '#ffffff' },
  { bg: '#3f6212', border: '#a3e635', fg: '#f7fee7' },
];

function guessDisplayNameFontSize(name: string): number {
  const n = name.trim().length;
  if (n <= 4) return 32;
  if (n <= 9) return 28;
  return 24;
}

function guessDisplayNameLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.12);
}

function trackSourceLabelForReveal(songSource: SongSource, track: GameTrack): string | null {
  if (songSource === 'liked') {
    return track.sourcePlaylistName?.trim() || LIKED_SONGS_SOURCE_NAME;
  }
  const n = track.sourcePlaylistName?.trim();
  return n ? n : null;
}

function playerInitials(nickname: string): string {
  const t = nickname.trim();
  if (!t) return '?';
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
  }
  return t.slice(0, 2).toUpperCase();
}

const AVATAR_BACKGROUNDS = ['#2d3a59', '#3d2d59', '#2d5942', '#59442d', '#2d5159', '#512d59'] as const;

function avatarBackground(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_BACKGROUNDS[h % AVATAR_BACKGROUNDS.length]!;
}

function PlayerAvatarBubble({ player, size }: { player: RoomPlayerRow; size: 'lobby' | 'score' }) {
  const dim = size === 'lobby' ? 52 : 36;
  const radius = dim / 2;
  return (
    <View
      style={[
        styles.playerAvatar,
        size === 'score' && { width: dim, height: dim, borderRadius: radius },
        { backgroundColor: avatarBackground(player.id), overflow: 'hidden' },
      ]}>
      {player.spotify_image_url ? (
        <Image
          source={{ uri: player.spotify_image_url }}
          style={{ width: dim, height: dim }}
          resizeMode="cover"
        />
      ) : (
        <Text style={[styles.playerAvatarText, size === 'score' && { fontSize: 13 }]}>
          {playerInitials(player.nickname)}
        </Text>
      )}
    </View>
  );
}

/** `null` = ready to start; otherwise user-facing reason (also used under the Start button). */
function lobbyValidationMessage(room: RoomRow, players: RoomPlayerRow[]): string | null {
  const contesters = players.filter((p) => !p.is_spectator);
  const minPlayers = UI_DEV_SKIP_SPOTIFY ? 1 : 2;
  if (contesters.length < minPlayers) {
    return minPlayers === 1
      ? 'Wait for someone to join the room.'
      : 'You need at least two players before starting.';
  }
  for (const p of contesters) {
    const pool = p.track_pool ?? [];
    if (pool.length === 0) {
      return UI_DEV_SKIP_SPOTIFY
        ? `${p.nickname} still needs tracks — use Add sample tracks below.`
        : `${p.nickname} has not loaded their library yet.`;
    }
    if (UI_DEV_SKIP_SPOTIFY) continue;
    if (pool.length > STALE_TRACK_POOL_MAX) {
      return `${p.nickname} needs to reload their library to a smaller preview-only list.`;
    }
    const prev = pool.filter((t) => Boolean(t.previewUrl)).length;
    if (prev === 0) {
      return `${p.nickname} has no previewable tracks yet.`;
    }
    if (prev < pool.length) {
      return `${p.nickname} still has songs without previews — reload the library.`;
    }
  }
  const played = new Set<string>();
  const entries = playableEntries(players, room.settings, played);
  if (!entries.length) {
    return 'No playable tracks with current settings. Add more music or turn off Deep cuts.';
  }
  return null;
}

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
  /** `undefined` = use server vote; otherwise show this id immediately while saving. */
  const [optimisticVotePlayerId, setOptimisticVotePlayerId] = useState<string | null | undefined>(
    undefined
  );
  const voteRequestSeq = useRef(0);
  const prevRoomIdRef = useRef<string | null>(null);
  const autoLibraryLoadedKey = useRef<string | null>(null);
  const lastConfettiBurstKey = useRef<string | null>(null);
  /** Last `rooms.settings` jsonb from Supabase — merge patches here so extra keys are not lost. */
  const roomSettingsRawRef = useRef<Record<string, unknown>>({});

  const [roomDissolved, setRoomDissolved] = useState(false);
  const [spotifyReady, setSpotifyReady] = useState(false);

  const [authRequest, response, promptAsync] = useSpotifyAuthRequest(SPOTIFY_CLIENT_ID);

  const me = useMemo(
    () => players.find((p) => p.user_id === myUserId) ?? null,
    [players, myUserId]
  );
  const contesters = useMemo(() => players.filter((p) => !p.is_spectator), [players]);
  const displayVotePlayerId =
    optimisticVotePlayerId !== undefined
      ? optimisticVotePlayerId
      : (me?.current_vote_player_id ?? null);
  const isHost = Boolean(room && myUserId && room.host_user_id === myUserId);

  const confettiBurstKey = useMemo(() => {
    if (!room || room.phase !== 'reveal' || !room.reveal_started_at) return null;
    if (!me?.current_vote_player_id) return null;
    if (me.current_vote_player_id !== room.correct_player_id) return null;
    return `${room.id}-${room.round_number}-${room.reveal_started_at}`;
  }, [
    room?.id,
    room?.phase,
    room?.reveal_started_at,
    room?.round_number,
    room?.correct_player_id,
    me?.current_vote_player_id,
  ]);

  const [confettiVisible, setConfettiVisible] = useState(false);
  const onConfettiComplete = useCallback(() => {
    setConfettiVisible(false);
  }, []);

  useEffect(() => {
    if (!confettiBurstKey) {
      setConfettiVisible(false);
      return;
    }
    if (lastConfettiBurstKey.current === confettiBurstKey) return;
    lastConfettiBurstKey.current = confettiBurstKey;
    setConfettiVisible(true);
  }, [confettiBurstKey]);

  useEffect(() => {
    setOptimisticVotePlayerId(undefined);
  }, [room?.phase, room?.round_number]);

  const refreshLocal = useCallback(async () => {
    const { data: r } = await supabase.from('rooms').select('*').eq('code', code).maybeSingle();
    if (!r) {
      if (prevRoomIdRef.current) {
        setRoom(null);
        setPlayers([]);
        setRoomDissolved(true);
        prevRoomIdRef.current = null;
      } else {
        setLoadErr('Room not found.');
      }
      return;
    }
    prevRoomIdRef.current = r.id as string;
    setRoomDissolved(false);
    setLoadErr(null);
    const rawRow = r as Record<string, unknown>;
    const rs = rawRow.settings;
    roomSettingsRawRef.current =
      rs && typeof rs === 'object' && !Array.isArray(rs)
        ? { ...(rs as Record<string, unknown>) }
        : {};
    setRoom(normalizeRoom(rawRow));
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
    if (UI_DEV_SKIP_SPOTIFY) return;
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
        const profileImg = pickSpotifyProfileImageUrl(profile.images);
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return;
        const { data: rrow } = await supabase.from('rooms').select('id').eq('code', code).maybeSingle();
        if (!rrow?.id) return;
        await supabase
          .from('room_players')
          .update({
            spotify_display_name: profile.display_name ?? profile.id,
            spotify_image_url: profileImg,
          })
          .eq('room_id', rrow.id)
          .eq('user_id', uid);
        await refreshLocal();
        setSpotifyReady(true);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : 'Spotify login failed');
      }
    })();
  }, [response, authRequest, code, refreshLocal]);

  useEffect(() => {
    prevRoomIdRef.current = null;
    setRoomDissolved(false);
    autoLibraryLoadedKey.current = null;
  }, [code]);

  useEffect(() => {
    if (UI_DEV_SKIP_SPOTIFY || !SPOTIFY_CLIENT_ID) {
      setSpotifyReady(false);
      return;
    }
    void hasSpotifySession(SPOTIFY_CLIENT_ID).then(setSpotifyReady);
  }, []);

  async function loadMockTracksForUi() {
    if (!UI_DEV_SKIP_SPOTIFY) return;
    if (!room) {
      setLoadErr('Room not loaded yet.');
      return;
    }
    if (!me?.id) {
      setLoadErr('Your seat is not ready yet — wait a moment or rejoin the room.');
      return;
    }
    setLoadErr(null);
    setTrackNotice(null);
    setBusy('Saving mock tracks…');
    try {
      const tracks = getMockTrackPoolForUi();
      const { error } = await supabase
        .from('room_players')
        .update({ track_pool: tracks, spotify_display_name: 'UI mock', spotify_image_url: null })
        .eq('id', me.id);
      if (error) throw error;
      await refreshLocal();
      setTrackNotice('Mock pool loaded — you can start the game (1+ players in UI dev mode).');
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Mock load failed');
    } finally {
      setBusy(null);
    }
  }

  async function loadMyTracks(): Promise<boolean> {
    if (UI_DEV_SKIP_SPOTIFY) {
      setLoadErr('UI dev mode is on — use “Add sample tracks” instead of Spotify.');
      return false;
    }
    if (!room) {
      setLoadErr('Room not loaded yet.');
      return false;
    }
    if (!me?.id) {
      setLoadErr(
        'Your seat in this room is not ready yet. Wait a few seconds, reopen the room, or leave and rejoin with the code — then tap Load again.'
      );
      return false;
    }
    if (!SPOTIFY_CLIENT_ID) {
      setLoadErr('Spotify is not configured in this build.');
      return false;
    }
    setLoadErr(null);
    setTrackNotice(null);
    setBusy('Fetching Spotify…');
    try {
      const token = await getValidAccessToken(SPOTIFY_CLIENT_ID);
      if (!token) {
        setBusy(null);
        setLoadErr('Connect Spotify first.');
        setSpotifyReady(false);
        return false;
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
        setBusy(`Loading tracks from playlists (sampling ${fetchSize} for previews)…`);
        tracks = await fetchTracksFromPlaylists(token, lists, { sampleTarget: fetchSize });
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
        return false;
      }
      if (tracks.length < poolTarget) {
        setTrackNotice(
          `${tracks.length} previewable tracks saved (wanted up to ${poolTarget} — try more playlists or run “Load” again).`
        );
      }
      setSpotifyReady(true);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fetch failed';
      const hint =
        msg.includes('Failed to fetch') || msg.includes('Network request failed')
          ? ' Check your network. On web, ad blockers or strict privacy settings can block Spotify’s API.'
          : '';
      setLoadErr(`${msg}${hint}`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!room || room.phase !== 'lobby' || room.status !== 'lobby') return;
    if (UI_DEV_SKIP_SPOTIFY || !SPOTIFY_CLIENT_ID || !me?.id) return;
    if ((me.track_pool?.length ?? 0) > 0) return;
    const autoKey = `${room.id}:${room.updated_at ?? ''}`;
    if (autoLibraryLoadedKey.current === autoKey) return;
    let cancelled = false;
    void (async () => {
      const ok = await hasSpotifySession(SPOTIFY_CLIENT_ID);
      if (cancelled || !ok) return;
      await loadMyTracks();
      if (!cancelled) {
        autoLibraryLoadedKey.current = autoKey;
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally omit loadMyTracks from deps — stable enough for this one-shot auto fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    room?.id,
    room?.phase,
    room?.status,
    room?.updated_at,
    me?.id,
    me?.track_pool?.length,
    SPOTIFY_CLIENT_ID,
  ]);

  async function setRematchVote(vote: 'yes' | 'no') {
    if (!room?.id) return;
    setLoadErr(null);
    try {
      const { error } = await supabase.rpc('set_rematch_vote', {
        p_room_id: room.id,
        p_vote: vote,
      });
      if (error) throw new Error(error.message);
      if (vote === 'yes') {
        const { error: e2 } = await supabase.rpc('try_rematch', { p_room_id: room.id });
        if (e2) throw new Error(e2.message);
      }
      await refreshLocal();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Could not save your choice');
    }
  }

  async function leaveParty() {
    if (!room?.id) return;
    setBusy('Leaving…');
    setLoadErr(null);
    try {
      const { error } = await supabase.rpc('leave_room', { p_room_id: room.id });
      if (error) throw new Error(error.message);
      router.replace('/');
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Could not leave room');
      await refreshLocal();
    } finally {
      setBusy(null);
    }
  }

  async function persistVoteChoice(playerRowId: string, nextVote: string | null) {
    const { error } = await supabase
      .from('room_players')
      .update({ current_vote_player_id: nextVote })
      .eq('id', playerRowId);
    if (error) throw new Error(error.message);
    await refreshLocal();
  }

  function onVoteChipPress(targetPlayerId: string) {
    if (!me?.id || !room || room.phase !== 'guess') return;
    const rowId = me.id;
    const current =
      optimisticVotePlayerId !== undefined
        ? optimisticVotePlayerId
        : (me.current_vote_player_id ?? null);
    const next = current === targetPlayerId ? null : targetPlayerId;
    const seq = ++voteRequestSeq.current;
    setOptimisticVotePlayerId(next);
    void (async () => {
      try {
        await persistVoteChoice(rowId, next);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : 'Vote failed');
        await refreshLocal();
      } finally {
        if (voteRequestSeq.current === seq) {
          setOptimisticVotePlayerId(undefined);
        }
      }
    })();
  }

  const inLobby = Boolean(room && (room.phase === 'lobby' || room.status === 'lobby'));

  const lobbyState = useMemo(() => {
    if (!room || (room.phase !== 'lobby' && room.status !== 'lobby')) {
      return {
        isLobby: false,
        poolTarget: 0,
        barPct: 0,
        poolLine: '',
        canStart: false,
        startHint: '',
      };
    }
    const poolTarget = trackPoolSampleTarget(room.settings.rounds, room.settings.deepCuts);
    const contesters = players.filter((p) => !p.is_spectator);
    if (!contesters.length) {
      return {
        isLobby: true,
        poolTarget,
        barPct: 0,
        poolLine: 'Waiting for players to join…',
        canStart: false,
        startHint: lobbyValidationMessage(room, players) ?? 'Waiting for players to join…',
      };
    }
    const scored = contesters.map((p) => {
      const pool = p.track_pool ?? [];
      const prev = pool.filter((t) => Boolean(t.previewUrl)).length;
      if (pool.length === 0) return { nick: p.nickname, prev, score: 0 };
      if (!UI_DEV_SKIP_SPOTIFY && pool.length > STALE_TRACK_POOL_MAX) {
        return { nick: p.nickname, prev, score: 0 };
      }
      if (!UI_DEV_SKIP_SPOTIFY && prev < pool.length) {
        return { nick: p.nickname, prev, score: (prev / pool.length) * 0.35 };
      }
      if (prev === 0) return { nick: p.nickname, prev, score: 0 };
      return { nick: p.nickname, prev, score: Math.min(1, prev / poolTarget) };
    });
    const minScore = Math.min(...scored.map((s) => s.score));
    const weakest = scored.reduce((a, b) => (b.score < a.score ? b : a));
    const barPct = Math.round(minScore * 100);
    const poolLine = `${weakest.nick} · ${weakest.prev} / ~${poolTarget} preview tracks`;
    const msg = lobbyValidationMessage(room, players);
    return {
      isLobby: true,
      poolTarget,
      barPct,
      poolLine,
      canStart: msg === null,
      startHint: msg ?? '',
    };
  }, [room, players]);

  async function setPartyModeEnabled(next: boolean) {
    if (!room?.id || !isHost || !inLobby) return;
    setLoadErr(null);
    try {
      const merged = mergePersistedRoomSettings(roomSettingsRawRef.current, { partyMode: next });
      const { error } = await supabase.from('rooms').update({ settings: merged }).eq('id', room.id);
      if (error) throw new Error(error.message);
      roomSettingsRawRef.current = merged;
      await refreshLocal();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Could not update party mode');
    }
  }

  async function sharePartyDeckLink() {
    if (!room) return;
    const url = partyDeckAbsoluteUrlForCode(room.code);
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return;
      }
      await Share.share({ message: url, ...(Platform.OS === 'ios' ? { url } : {}) });
    } catch {
      /* user dismissed share sheet or clipboard blocked */
    }
  }

  async function clearVotes(roomId: string) {
    await supabase.from('room_players').update({ current_vote_player_id: null }).eq('room_id', roomId);
  }

  async function startGame() {
    if (!room || !isHost) return;
    const msg = lobbyValidationMessage(room, players);
    if (msg) {
      setLoadErr(msg);
      return;
    }
    setBusy('Starting…');
    try {
      await clearVotes(room.id);
      const played = new Set<string>();
      const entries = playableEntries(players, room.settings, played);
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

  const insets = useSafeAreaInsets();

  if (roomDissolved) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.dissolvedTitle}>Party ended</Text>
        <Text style={styles.dissolvedSub}>
          The room closed because too few players remained, or the host left.
        </Text>
        <Pressable style={styles.primary} onPress={() => router.replace('/')}>
          <Text style={styles.primaryText}>Back to home</Text>
        </Pressable>
      </View>
    );
  }

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

  const guessPlayerCount = contesters.length;
  const guessChoicesGridStyle =
    guessPlayerCount === 1
      ? styles.choicesGridSingle
      : guessPlayerCount === 2
        ? styles.choicesGridTwo
        : guessPlayerCount === 4
          ? styles.choicesGridFour
          : guessPlayerCount === 3
            ? styles.choicesGridRow
            : styles.choicesGridMany;
  const guessChipLayoutStyle =
    guessPlayerCount <= 1
      ? styles.choiceGuessLayout1Fill
      : guessPlayerCount === 2
        ? styles.choiceGuessLayoutTwo
        : guessPlayerCount <= 3
          ? styles.choiceGuessLayoutEqual
          : guessPlayerCount === 4
            ? styles.choiceGuessLayoutFour
            : styles.choiceGuessLayoutMany;

  const renderGuessQuizGrid = () => (
    <View style={[styles.choicesGrid, guessChoicesGridStyle]}>
      {contesters.map((p, index) => {
        const selected = displayVotePlayerId === p.id;
        const pal = GUESS_PLAYER_PALETTE[index % GUESS_PLAYER_PALETTE.length]!;
        const fs = guessDisplayNameFontSize(p.nickname);
        return (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            android_ripple={{ color: 'rgba(255,255,255,0.35)' }}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            onPress={() => onVoteChipPress(p.id)}
            disabled={!me}
            style={(s) => {
              const pressed = s.pressed;
              const hovered = 'hovered' in s && (s as { hovered?: boolean }).hovered === true;
              return [
                styles.choiceGuessQuiz,
                guessChipLayoutStyle,
                { backgroundColor: pal.bg, borderColor: selected ? '#ffffff' : pal.border },
                selected ? styles.choiceGuessQuizSelected : { borderWidth: 2 },
                Platform.OS === 'web' && styles.choiceGuessWeb,
                !selected && hovered && Platform.OS === 'web' && styles.choiceGuessQuizHover,
                pressed && styles.choiceGuessQuizPressed,
                selected && Platform.OS === 'web' && styles.choiceGuessQuizSelectedWebRing,
              ];
            }}>
            <Text
              style={[
                styles.choiceTextGuessDisplay,
                {
                  color: pal.fg,
                  fontSize: fs,
                  lineHeight: guessDisplayNameLineHeight(fs),
                },
              ]}
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.65}>
              {p.nickname}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

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
            {room.settings.partyMode ? (
              <View style={styles.guessPartyColumn}>
                <TrackPreview
                  uri={room.current_track!.previewUrl}
                  replayToken={`${room.round_number}-${room.current_track!.id}`}
                />
                <Text style={styles.partyModeListenHint}>
                  Open the party speaker link on a TV or second device for the room. The preview also plays here so
                  you can hear while voting{Platform.OS === 'web' ? ' (use “Tap to play preview sound” if the browser blocks audio)' : ''}.
                </Text>
                <Text style={styles.roundMetaParty}>
                  Round {room.round_number} / {room.settings.rounds}
                </Text>
                <Text style={styles.guessCardTitle}>Who owns this track?</Text>
                {guessPlayerCount <= 2 ? (
                  <View style={styles.guessChoicesFill}>{renderGuessQuizGrid()}</View>
                ) : (
                  <ScrollView
                    style={styles.guessChoicesScroll}
                    contentContainerStyle={styles.guessChoicesScrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}>
                    {renderGuessQuizGrid()}
                  </ScrollView>
                )}
                <Text style={styles.voteHint}>
                  Tap a name to vote. Tap the same name again to clear — you can skip this round.
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.guessHalfArt}>
                  <TrackPreview
                    uri={room.current_track!.previewUrl}
                    replayToken={`${room.round_number}-${room.current_track!.id}`}
                  />
                  {!room.current_track!.previewUrl ? (
                    <Text style={styles.previewNoteGuess}>
                      No preview clip — guess from title & artist.
                    </Text>
                  ) : null}
                  <View style={styles.guessArtFrame}>
                    {room.current_track!.imageUrl ? (
                      <Image
                        source={{ uri: room.current_track!.imageUrl }}
                        style={styles.artGuessContain}
                        resizeMode="contain"
                      />
                    ) : (
                      <View style={styles.artGuessPlaceholder}>
                        <Text style={styles.artGuessPlaceholderText}>No cover art</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.guessTrackMeta}>
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
                </View>
                <View style={styles.guessHalfPlayers}>
                  <Text style={styles.guessCardTitle}>Who owns this track?</Text>
                  {guessPlayerCount <= 2 ? (
                    <View style={styles.guessChoicesFill}>{renderGuessQuizGrid()}</View>
                  ) : (
                    <ScrollView
                      style={styles.guessChoicesScroll}
                      contentContainerStyle={styles.guessChoicesScrollContent}
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={false}>
                      {renderGuessQuizGrid()}
                    </ScrollView>
                  )}
                  <Text style={styles.voteHint}>
                    Tap a name to vote. Tap the same name again to clear — you can skip this round.
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.nonGuessRoot}>
          <ScrollView
            style={styles.scrollFlex}
            contentContainerStyle={[
              styles.scroll,
              inLobby ? { paddingBottom: insets.bottom + 148 } : undefined,
            ]}
            keyboardShouldPersistTaps="handled">
            <View style={styles.roomHero}>
              <Text style={styles.roomHeroKicker}>Room</Text>
              <Text style={styles.roomHeroCode}>{room.code}</Text>
            </View>

            {loadErr ? (
              <View style={styles.bannerErr}>
                <Text style={styles.bannerErrText}>{loadErr}</Text>
              </View>
            ) : null}
            {busy ? (
              <View style={styles.busyRow}>
                <ActivityIndicator color={theme.accent} />
                <Text style={styles.busyLabel}>Working…</Text>
              </View>
            ) : null}
            {trackNotice ? <Text style={styles.trackNoticeSpaced}>{trackNotice}</Text> : null}

            {inLobby ? (
              <View style={styles.lobbyBody}>
                <Text style={styles.sectionHeading}>Players</Text>
                <View style={styles.playerList}>
                  {players.map((p) => {
                    const pool = p.track_pool ?? [];
                    const previewCount = pool.filter((t) => Boolean(t.previewUrl)).length;
                    const hostSeat = p.user_id === room.host_user_id;
                    return (
                      <View key={p.id} style={styles.playerCard}>
                        <PlayerAvatarBubble player={p} size="lobby" />
                        <View style={styles.playerCardMain}>
                          <View style={styles.playerNameRow}>
                            <Text style={styles.playerName} numberOfLines={1}>
                              {p.nickname}
                            </Text>
                            {hostSeat ? (
                              <View style={styles.hostBadge}>
                                <Text style={styles.hostBadgeText}>Host</Text>
                              </View>
                            ) : null}
                            {p.is_spectator ? (
                              <View style={styles.speakerBadge}>
                                <Text style={styles.speakerBadgeText}>Speaker</Text>
                              </View>
                            ) : null}
                          </View>
                          {p.spotify_display_name ? (
                            <Text style={styles.playerSpotifyName} numberOfLines={1}>
                              {p.spotify_display_name}
                            </Text>
                          ) : null}
                        </View>
                        <View style={styles.trackCountBadge}>
                          <Text style={styles.trackCountBadgeValue}>{previewCount}</Text>
                          <Text style={styles.trackCountBadgeLabel}>tracks</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>

                <View style={styles.poolCard}>
                  <Text style={styles.sectionHeading}>Song pool</Text>
                  <Text style={styles.poolSub}>{lobbyState.poolLine}</Text>
                  <View style={styles.progressTrack}>
                    <View
                      style={[styles.progressFill, { width: `${Math.min(100, lobbyState.barPct)}%` }]}
                    />
                  </View>
                  <Text style={styles.poolHint}>
                    Strength is based on the smallest preview library in the room.
                  </Text>
                </View>

                {isHost ? (
                  <View style={styles.partyModeCard}>
                    <View style={styles.partyModeRow}>
                      <View style={styles.partyModeLabelCol}>
                        <Text style={styles.sectionHeading}>Party mode</Text>
                        <Text style={styles.partyModeHelp}>
                          One speaker plays the clip for everyone; phones show only the vote grid.
                        </Text>
                      </View>
                      <Switch
                        accessibilityLabel="Party mode"
                        value={Boolean(room.settings.partyMode)}
                        onValueChange={(v) => void setPartyModeEnabled(v)}
                      />
                    </View>
                  </View>
                ) : null}

                {room.settings.partyMode ? (
                  <View style={styles.partyDeckCard}>
                    <Text style={styles.sectionHeading}>Party speaker</Text>
                    <Text style={styles.partyDeckHelp}>
                      Open this link on the TV or stereo device (stay on this page during the game).
                    </Text>
                    <Text style={styles.partyDeckUrl} selectable>
                      {partyDeckUrlForCode(room.code)}
                    </Text>
                    <Pressable style={styles.partyDeckShareBtn} onPress={() => void sharePartyDeckLink()}>
                      <Text style={styles.partyDeckShareBtnText}>Copy or share link</Text>
                    </Pressable>
                  </View>
                ) : null}

                {UI_DEV_SKIP_SPOTIFY && me && (me.track_pool?.length ?? 0) === 0 ? (
                  <Pressable
                    style={styles.linkAction}
                    onPress={() => void loadMockTracksForUi()}
                    disabled={Boolean(busy)}>
                    <Text style={styles.linkActionText}>Add sample tracks</Text>
                  </Pressable>
                ) : null}

                {!UI_DEV_SKIP_SPOTIFY ? (
                  <View style={styles.lobbySpotifyBlock}>
                    {!spotifyReady ? (
                      <Pressable
                        style={[
                          styles.lobbyGhostBtnFull,
                          (!authRequest || !SPOTIFY_CLIENT_ID) && styles.lobbyGhostBtnDim,
                        ]}
                        onPress={() => promptAsync()}
                        disabled={!authRequest || !SPOTIFY_CLIENT_ID}>
                        <Text style={styles.lobbyGhostBtnText}>Connect Spotify</Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.spotifyConnectedNote}>
                        Spotify is linked on this device. Your library will refresh automatically when
                        everyone agrees to play again.
                      </Text>
                    )}
                    <Pressable
                      style={styles.lobbyGhostBtnFull}
                      onPress={() => void loadMyTracks()}
                      disabled={Boolean(busy)}>
                      <Text style={styles.lobbyGhostBtnText}>
                        Reload {room.settings.songSource === 'liked' ? 'liked songs' : 'playlists'}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                <Pressable style={styles.lobbyLeaveLink} onPress={() => void leaveParty()}>
                  <Text style={styles.lobbyLeaveLinkText}>Leave room</Text>
                </Pressable>
              </View>
            ) : null}

            {room.phase === 'reveal' && room.current_track ? (
        <View style={[styles.card, styles.cardSpaced]}>
          <Text style={styles.cardTitle}>Answer</Text>
          <Text style={styles.trackTitle}>{room.current_track.name}</Text>
          <Text style={styles.answer}>Owner: {correctPlayer?.nickname ?? 'Unknown'}</Text>
          {(() => {
            const src = trackSourceLabelForReveal(room.settings.songSource, room.current_track);
            return src ? <Text style={styles.revealSource}>From: {src}</Text> : null;
          })()}
          <Text style={styles.muted}>+100 for each correct guess.</Text>
          {revealSecondsLeft !== null ? (
            <Text style={styles.revealCountdown}>Next round in {revealSecondsLeft}s…</Text>
          ) : null}
        </View>
      ) : null}

      {(room.phase === 'ended' || room.status === 'finished') && (
        <View style={[styles.card, styles.cardSpaced]}>
          <Text style={styles.cardTitle}>Game over</Text>
          <Text style={styles.rematchExplainer}>
            Play again? Everyone must choose Play again to start a new match. Back leaves the party
            — if too few players remain, the room closes for everyone.
          </Text>
          {[...contesters]
            .sort((a, b) => b.score - a.score)
            .map((p, i) => (
              <View key={p.id} style={styles.scoreRowWithVote}>
                <View style={styles.scoreRowLeft}>
                  <PlayerAvatarBubble player={p} size="score" />
                  <Text style={styles.scoreRow} numberOfLines={1}>
                    {i + 1}. {p.nickname} — {p.score} pts
                  </Text>
                </View>
                <Text style={styles.rematchBadge}>
                  {p.rematch_choice === 'yes'
                    ? 'Play again'
                    : p.rematch_choice === 'no'
                      ? 'Done'
                      : 'Waiting'}
                </Text>
              </View>
            ))}
          {me ? (
            <View style={styles.rematchActions}>
              <Pressable
                style={[
                  styles.rematchPrimary,
                  me.rematch_choice === 'yes' && styles.rematchPrimaryOn,
                  busy && styles.rematchBtnDisabled,
                ]}
                disabled={Boolean(busy)}
                onPress={() => void setRematchVote('yes')}>
                <Text
                  style={[
                    styles.rematchPrimaryText,
                    me.rematch_choice === 'yes' && styles.rematchPrimaryTextOn,
                  ]}>
                  Play again
                </Text>
              </Pressable>
              <Pressable
                style={styles.secondary}
                disabled={Boolean(busy)}
                onPress={() => void leaveParty()}>
                <Text style={styles.secondaryText}>Back</Text>
              </Pressable>
            </View>
          ) : null}
          <Text style={styles.rematchHint}>
            {contesters.filter((p) => p.rematch_choice === 'yes').length} / {contesters.length} voted play
            again
          </Text>
        </View>
      )}
          </ScrollView>

          {inLobby ? (
            <View
              style={[
                styles.lobbyStickyFooter,
                {
                  paddingBottom: Math.max(insets.bottom, 18),
                  paddingTop: 16,
                },
              ]}>
              {isHost ? (
                <View style={styles.lobbyFooterInner}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !lobbyState.canStart || Boolean(busy) }}
                    style={[
                      styles.startGameCta,
                      (!lobbyState.canStart || busy) && styles.startGameCtaDisabled,
                    ]}
                    onPress={() => void startGame()}
                    disabled={!lobbyState.canStart || Boolean(busy)}>
                    <Text
                      style={[
                        styles.startGameCtaText,
                        (!lobbyState.canStart || busy) && styles.startGameCtaTextDisabled,
                      ]}>
                      Start game
                    </Text>
                  </Pressable>
                  {!lobbyState.canStart && lobbyState.startHint ? (
                    <Text style={styles.startGameHint}>{lobbyState.startHint}</Text>
                  ) : null}
                </View>
              ) : (
                <Text style={styles.waitHostFooter}>Waiting for host to start…</Text>
              )}
            </View>
          ) : null}
        </View>
      )}
      {confettiVisible && confettiBurstKey ? (
        <ConfettiCelebration key={confettiBurstKey} onComplete={onConfettiComplete} />
      ) : null}
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
  guessFill: { flex: 1, minHeight: 0, flexDirection: 'column' },
  guessPartyColumn: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    gap: 10,
    paddingTop: 4,
  },
  partyModeListenHint: {
    color: theme.textMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  roundMetaParty: { color: theme.textMuted, fontSize: 13, textAlign: 'center' },
  /** ~50% viewport: art + track meta; picture scales with `contain` inside `guessArtFrame`. */
  guessHalfArt: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    alignItems: 'center',
    gap: 4,
  },
  guessArtFrame: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    maxWidth: '100%',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: theme.surface2,
  },
  artGuessContain: { width: '100%', height: '100%' },
  artGuessPlaceholder: {
    flex: 1,
    minHeight: 120,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  artGuessPlaceholderText: { color: theme.textMuted, fontSize: 14, fontWeight: '600' },
  guessTrackMeta: { width: '100%', alignItems: 'center', gap: 2, paddingBottom: 4 },
  /** ~50% viewport: question + name chips. */
  guessHalfPlayers: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    gap: 6,
  },
  guessChoicesFill: { flex: 1, minHeight: 0, width: '100%' },
  guessChoicesScroll: { flex: 1, minHeight: 0, width: '100%' },
  guessChoicesScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 4,
  },
  guessCardTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: theme.text,
    marginTop: 0,
    flexShrink: 0,
  },
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
  voteHint: {
    color: theme.textMuted,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 8,
    lineHeight: 17,
    flexShrink: 0,
  },
  choicesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: '100%',
    gap: 10,
  },
  /** 1 player: fill lower area, one full-width tile. */
  choicesGridSingle: {
    flex: 1,
    flexDirection: 'column',
    minHeight: 0,
    alignItems: 'stretch',
  },
  /** 2 players: side-by-side, equal blocks filling available height. */
  choicesGridTwo: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'stretch',
    minHeight: 120,
    gap: 10,
  },
  /** 3 players: one row, equal widths. */
  choicesGridRow: {
    flexWrap: 'nowrap',
    justifyContent: 'space-between',
    alignItems: 'stretch',
  },
  /** 4 players: 2×2 grid. */
  choicesGridFour: {
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'stretch',
  },
  /** 5+ players: wrap with ~2 columns. */
  choicesGridMany: {
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  choiceGuessQuiz: {
    paddingVertical: 20,
    paddingHorizontal: 14,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  choiceGuessQuizSelected: {
    borderWidth: 4,
    borderColor: '#ffffff',
  },
  choiceGuessQuizHover: { opacity: 0.93 },
  choiceGuessQuizPressed: { opacity: 0.88 },
  choiceGuessQuizSelectedWebRing: {
    boxShadow: '0 0 0 2px rgba(255,255,255,0.95), 0 10px 28px rgba(0,0,0,0.45)',
  },
  choiceGuessLayout1Fill: {
    width: '100%',
    flex: 1,
    minHeight: 120,
    alignSelf: 'stretch',
  },
  choiceGuessLayoutTwo: {
    flex: 1,
    minWidth: 0,
    minHeight: 120,
    alignSelf: 'stretch',
  },
  choiceGuessLayoutEqual: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 96,
  },
  choiceGuessLayoutFour: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '48%',
    minWidth: 0,
    maxWidth: '50%',
    minHeight: 88,
  },
  choiceGuessLayoutMany: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: '40%',
    maxWidth: '48%',
    minHeight: 72,
  },
  /** Web: smooth hover / press (color only — no scale, so border and fill stay aligned). */
  choiceGuessWeb: {
    cursor: 'pointer',
    userSelect: 'none',
    transitionDuration: '140ms',
    transitionProperty: 'opacity, border-color, box-shadow',
    transitionTimingFunction: 'ease-out',
  },
  choiceTextGuessDisplay: {
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.4,
    width: '100%',
    paddingHorizontal: 6,
  },
  center: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  nonGuessRoot: { flex: 1, minHeight: 0, backgroundColor: theme.bg },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 40,
    backgroundColor: theme.bg,
  },
  scrollFlex: { flex: 1 },
  roomHero: { marginBottom: 28 },
  roomHeroKicker: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  roomHeroCode: {
    color: theme.text,
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 10,
    lineHeight: 52,
  },
  bannerErr: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 92, 92, 0.35)',
    backgroundColor: 'rgba(255, 92, 92, 0.08)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  bannerErrText: { color: theme.danger, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  busyLabel: { color: theme.textMuted, fontSize: 14, fontWeight: '600' },
  trackNoticeSpaced: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 20,
  },
  lobbyBody: { gap: 8, marginBottom: 8 },
  sectionHeading: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 14,
    marginTop: 4,
  },
  playerList: { gap: 14 },
  playerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 18,
    paddingHorizontal: 18,
    gap: 16,
  },
  playerAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerAvatarText: { color: theme.text, fontSize: 17, fontWeight: '800' },
  playerCardMain: { flex: 1, minWidth: 0 },
  playerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  playerName: { color: theme.text, fontSize: 17, fontWeight: '800', flexShrink: 1 },
  hostBadge: {
    backgroundColor: theme.surface2,
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: theme.border,
  },
  hostBadgeText: { color: theme.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  speakerBadge: {
    backgroundColor: theme.surface2,
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: theme.border,
  },
  speakerBadgeText: { color: theme.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  playerSpotifyName: { color: theme.textMuted, fontSize: 13, marginTop: 4 },
  trackCountBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface2,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minWidth: 64,
    borderWidth: 1,
    borderColor: theme.border,
  },
  trackCountBadgeValue: { color: theme.text, fontSize: 18, fontWeight: '900' },
  trackCountBadgeLabel: { color: theme.textMuted, fontSize: 10, fontWeight: '700', marginTop: 2 },
  poolCard: {
    marginTop: 28,
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 22,
    gap: 12,
  },
  poolSub: { color: theme.text, fontSize: 15, fontWeight: '700' },
  poolHint: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
  partyModeCard: {
    marginTop: 20,
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 18,
    gap: 8,
  },
  partyModeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  partyModeLabelCol: { flex: 1, minWidth: 0 },
  partyModeHelp: { color: theme.textMuted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  partyDeckCard: {
    marginTop: 16,
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 18,
    gap: 10,
  },
  partyDeckHelp: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
  partyDeckUrl: { color: theme.accent, fontSize: 13, lineHeight: 18 },
  partyDeckShareBtn: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: theme.surface2,
    borderWidth: 1,
    borderColor: theme.border,
  },
  partyDeckShareBtnText: { color: theme.text, fontSize: 14, fontWeight: '800' },
  progressTrack: {
    height: 12,
    borderRadius: 8,
    backgroundColor: theme.surface2,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: {
    height: 12,
    borderRadius: 8,
    backgroundColor: theme.accent,
  },
  linkAction: { alignSelf: 'center', marginTop: 20, paddingVertical: 8, paddingHorizontal: 12 },
  linkActionText: { color: theme.accent, fontSize: 15, fontWeight: '800' },
  lobbySpotifyBlock: { gap: 12, marginTop: 24 },
  lobbyGhostBtnFull: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lobbyGhostBtnDim: { opacity: 0.45 },
  lobbyGhostBtnText: { color: theme.text, fontSize: 14, fontWeight: '700' },
  spotifyConnectedNote: {
    color: theme.textMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  lobbyLeaveLink: { alignSelf: 'center', marginTop: 22, paddingVertical: 10 },
  lobbyLeaveLinkText: { color: theme.textMuted, fontSize: 14, fontWeight: '700' },
  cardSpaced: { marginTop: 28 },
  lobbyStickyFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 4,
    paddingHorizontal: 24,
    backgroundColor: theme.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  lobbyFooterInner: { gap: 10 },
  startGameCta: {
    borderRadius: 16,
    backgroundColor: theme.accent,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  startGameCtaDisabled: { opacity: 0.48 },
  startGameCtaText: { color: '#04210f', fontSize: 17, fontWeight: '900' },
  startGameCtaTextDisabled: { opacity: 0.55 },
  startGameHint: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  waitHostFooter: {
    color: theme.textMuted,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 18,
  },
  codeLabel: { color: theme.textMuted, fontSize: 13 },
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
  answer: { fontSize: 18, fontWeight: '700', color: theme.accent, marginTop: 6 },
  revealCountdown: { fontSize: 16, fontWeight: '800', color: theme.text, marginTop: 8 },
  revealSource: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.accent,
    marginTop: 6,
    textAlign: 'center',
  },
  scoreRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  scoreRow: { color: theme.text, fontSize: 16, paddingVertical: 4, flex: 1 },
  scoreRowWithVote: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  rematchExplainer: {
    color: theme.textMuted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 12,
  },
  rematchBadge: { fontSize: 12, fontWeight: '700', color: theme.accent, marginLeft: 12 },
  rematchActions: { gap: 12, marginTop: 18 },
  rematchPrimary: {
    borderRadius: 14,
    backgroundColor: theme.surface2,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: theme.border,
  },
  rematchPrimaryOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  rematchPrimaryText: { color: theme.text, fontSize: 16, fontWeight: '900' },
  rematchPrimaryTextOn: { color: '#04210f' },
  rematchHint: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 14,
    marginBottom: 8,
  },
  rematchBtnDisabled: { opacity: 0.45 },
  dissolvedTitle: { fontSize: 22, fontWeight: '900', color: theme.text, marginBottom: 10 },
  dissolvedSub: {
    color: theme.textMuted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 12,
  },
});
