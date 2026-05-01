import type { GameTrack, RematchChoice, RoomPlayerRow, RoomRow, RoomSettings } from '@/lib/types';
import { combinedPlayablePool } from '@/lib/uniquePool';

export type PlayableEntry = { track: GameTrack; ownerPlayerId: string };

export function playableEntries(
  players: RoomPlayerRow[],
  settings: RoomSettings,
  playedIds: Set<string>
): PlayableEntry[] {
  const pools: Record<string, GameTrack[]> = {};
  for (const p of players) {
    if (p.is_spectator) continue;
    pools[p.id] = Array.isArray(p.track_pool) ? (p.track_pool as GameTrack[]) : [];
  }
  const combined = combinedPlayablePool(pools, settings.deepCuts);
  return combined.filter((e) => !playedIds.has(e.track.id));
}

export function pickRandom<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Fisher–Yates shuffle (mutates array in place). */
export function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

/**
 * How many tracks to pull from Spotify per player — tied to `rounds`, not the whole library.
 * Extra headroom helps deep cuts (only “unique to you” tracks) and preview misses.
 */
export function trackPoolSampleTarget(rounds: number, deepCuts: boolean): number {
  const r = Math.max(5, Math.min(20, rounds));
  const mult = deepCuts ? 8 : 5;
  return Math.min(200, Math.max(r * mult, r + 15));
}

/**
 * How many tracks to request from Spotify before we filter to **preview-only** tracks.
 * Oversampling offsets Spotify/Deezer misses while keeping Deezer calls bounded.
 */
export function trackPoolFetchSampleTarget(poolTarget: number): number {
  return Math.min(350, Math.max(120, poolTarget * 6));
}

/** Pools larger than this are treated as pre–preview-only full imports. */
export const STALE_TRACK_POOL_MAX = 220;

/** Typed slice of `rooms.settings` jsonb (unknown keys are ignored here but preserved via merge helpers). */
export function normalizeRoomSettings(raw: unknown): RoomSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const mcRaw = s.maxContestants;
  let maxContestants: number | undefined;
  if (mcRaw != null && mcRaw !== '') {
    const n = Number(mcRaw);
    if (Number.isFinite(n)) maxContestants = n;
  }
  return {
    rounds: Number(s.rounds ?? 10),
    songSource: s.songSource === 'liked' ? 'liked' : 'playlists',
    secondsPerRound: Number(s.secondsPerRound ?? 20),
    deepCuts: Boolean(s.deepCuts ?? true),
    partyMode: Boolean(s.partyMode),
    maxContestants,
  };
}

/**
 * Merge a partial settings update into the last persisted jsonb object so ad-hoc keys
 * (e.g. maxContestants) are not dropped on host PATCH.
 */
export function mergePersistedRoomSettings(
  previousRaw: Record<string, unknown>,
  patch: Partial<RoomSettings>
): Record<string, unknown> {
  const o: Record<string, unknown> = { ...previousRaw };
  if (patch.rounds !== undefined) o.rounds = patch.rounds;
  if (patch.songSource !== undefined) o.songSource = patch.songSource;
  if (patch.secondsPerRound !== undefined) o.secondsPerRound = patch.secondsPerRound;
  if (patch.deepCuts !== undefined) o.deepCuts = patch.deepCuts;
  if (patch.partyMode !== undefined) o.partyMode = patch.partyMode;
  if ('maxContestants' in patch) {
    const v = patch.maxContestants;
    if (v == null || Number.isNaN(Number(v))) {
      delete o.maxContestants;
    } else {
      o.maxContestants = v;
    }
  }
  return o;
}

export function normalizeRoom(row: Record<string, unknown>): RoomRow {
  return {
    id: String(row.id),
    code: String(row.code),
    host_user_id: String(row.host_user_id),
    status: row.status as RoomRow['status'],
    phase: row.phase as RoomRow['phase'],
    settings: normalizeRoomSettings(row.settings),
    round_number: Number(row.round_number ?? 0),
    played_track_ids: Array.isArray(row.played_track_ids)
      ? (row.played_track_ids as string[])
      : [],
    current_track: (row.current_track as GameTrack | null) ?? null,
    correct_player_id: row.correct_player_id ? String(row.correct_player_id) : null,
    round_started_at: row.round_started_at ? String(row.round_started_at) : null,
    reveal_started_at: row.reveal_started_at ? String(row.reveal_started_at) : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function normalizePlayer(row: Record<string, unknown>): RoomPlayerRow {
  return {
    id: String(row.id),
    room_id: String(row.room_id),
    user_id: String(row.user_id),
    nickname: String(row.nickname ?? ''),
    spotify_display_name: row.spotify_display_name ? String(row.spotify_display_name) : null,
    spotify_image_url: row.spotify_image_url ? String(row.spotify_image_url) : null,
    track_pool: Array.isArray(row.track_pool) ? (row.track_pool as GameTrack[]) : [],
    score: Number(row.score ?? 0),
    ready: Boolean(row.ready),
    current_vote_player_id: row.current_vote_player_id
      ? String(row.current_vote_player_id)
      : null,
    rematch_choice: parseRematchChoice(row.rematch_choice),
    is_spectator: Boolean(row.is_spectator),
  };
}

function parseRematchChoice(raw: unknown): RematchChoice {
  const s = typeof raw === 'string' ? raw : '';
  if (s === 'pending' || s === 'yes' || s === 'no' || s === 'idle') return s;
  return 'idle';
}
