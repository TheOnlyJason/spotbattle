import type { GameTrack, RoomPlayerRow, RoomSettings, RoomRow } from '@/lib/types';
import { combinedPlayablePool } from '@/lib/uniquePool';

export type PlayableEntry = { track: GameTrack; ownerPlayerId: string };

export function playableEntries(
  players: RoomPlayerRow[],
  settings: RoomSettings,
  playedIds: Set<string>
): PlayableEntry[] {
  const pools: Record<string, GameTrack[]> = {};
  for (const p of players) {
    pools[p.id] = Array.isArray(p.track_pool) ? (p.track_pool as GameTrack[]) : [];
  }
  const combined = combinedPlayablePool(pools, settings.deepCuts);
  return combined.filter((e) => !playedIds.has(e.track.id));
}

export function pickRandom<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function normalizeRoom(row: Record<string, unknown>): RoomRow {
  const settings = (row.settings ?? {}) as RoomSettings;
  return {
    id: String(row.id),
    code: String(row.code),
    host_user_id: String(row.host_user_id),
    status: row.status as RoomRow['status'],
    phase: row.phase as RoomRow['phase'],
    settings: {
      rounds: Number(settings.rounds ?? 10),
      songSource: settings.songSource === 'liked' ? 'liked' : 'playlists',
      secondsPerRound: Number(settings.secondsPerRound ?? 20),
      deepCuts: Boolean(settings.deepCuts ?? true),
    },
    round_number: Number(row.round_number ?? 0),
    played_track_ids: Array.isArray(row.played_track_ids)
      ? (row.played_track_ids as string[])
      : [],
    current_track: (row.current_track as GameTrack | null) ?? null,
    correct_player_id: row.correct_player_id ? String(row.correct_player_id) : null,
    round_started_at: row.round_started_at ? String(row.round_started_at) : null,
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
    track_pool: Array.isArray(row.track_pool) ? (row.track_pool as GameTrack[]) : [],
    score: Number(row.score ?? 0),
    ready: Boolean(row.ready),
    current_vote_player_id: row.current_vote_player_id
      ? String(row.current_vote_player_id)
      : null,
  };
}
