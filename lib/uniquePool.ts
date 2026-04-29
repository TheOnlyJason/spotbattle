import type { GameTrack } from '@/lib/types';

/** Tracks that appear in exactly one player's pool (Deep Cuts). */
export function uniqueTracksPerPlayer(
  pools: Record<string, GameTrack[]>
): Record<string, GameTrack[]> {
  const idToOwners: Record<string, string[]> = {};
  for (const [playerId, tracks] of Object.entries(pools)) {
    for (const t of tracks) {
      if (!idToOwners[t.id]) idToOwners[t.id] = [];
      idToOwners[t.id].push(playerId);
    }
  }
  const uniqueIds = new Set(
    Object.entries(idToOwners)
      .filter(([, owners]) => owners.length === 1)
      .map(([id]) => id)
  );
  const out: Record<string, GameTrack[]> = {};
  for (const [playerId, tracks] of Object.entries(pools)) {
    out[playerId] = tracks.filter((t) => uniqueIds.has(t.id));
  }
  return out;
}

export function combinedPlayablePool(
  pools: Record<string, GameTrack[]>,
  deepCuts: boolean
): { track: GameTrack; ownerPlayerId: string }[] {
  const effective = deepCuts ? uniqueTracksPerPlayer(pools) : { ...pools };
  const list: { track: GameTrack; ownerPlayerId: string }[] = [];
  for (const [ownerPlayerId, tracks] of Object.entries(effective)) {
    for (const track of tracks) {
      list.push({ track, ownerPlayerId });
    }
  }
  return list;
}
