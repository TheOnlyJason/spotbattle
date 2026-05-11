import { Image, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/constants/theme';
import type { RoomPlayerRow, RoundRecapEntry } from '@/lib/types';

const MINI = 28;

function initials(nickname: string): string {
  const t = nickname.trim();
  if (!t) return '?';
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
  }
  return t.slice(0, 2).toUpperCase();
}

function RecapAvatar({ player }: { player: RoomPlayerRow }) {
  return (
    <View style={styles.miniAvatar}>
      {player.spotify_image_url ? (
        <Image source={{ uri: player.spotify_image_url }} style={styles.miniImg} resizeMode="cover" />
      ) : (
        <Text style={styles.miniInitials}>{initials(player.nickname)}</Text>
      )}
    </View>
  );
}

type Props = {
  entries: RoundRecapEntry[];
  players: RoomPlayerRow[];
};

/** Numbered song rows with avatars of players who guessed the owner correctly. */
export function RoundRecapList({ entries, players }: Props) {
  if (!entries.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Guesses this match</Text>
      {entries.map((e, i) => (
        <View key={`${e.round}-${e.trackId}-${i}`} style={styles.row}>
          <Text style={styles.index}>{i + 1}.</Text>
          <Text style={styles.trackName} numberOfLines={2}>
            {e.trackName}
          </Text>
          <View style={styles.avatarRow}>
            {e.correctVoterIds.length === 0 ? (
              <Text style={styles.dash}>—</Text>
            ) : (
              e.correctVoterIds.map((id) => {
                const p = players.find((x) => x.id === id);
                return p ? <RecapAvatar key={id} player={p} /> : null;
              })
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 14,
    gap: 8,
  },
  title: {
    color: theme.textMuted,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.surface2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
  },
  index: {
    width: 22,
    fontSize: 14,
    fontWeight: '800',
    color: theme.textMuted,
  },
  trackName: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '600',
    color: theme.text,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  dash: {
    color: theme.textMuted,
    fontSize: 16,
    paddingHorizontal: 4,
  },
  miniAvatar: {
    width: MINI,
    height: MINI,
    borderRadius: MINI / 2,
    overflow: 'hidden',
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.border,
  },
  miniImg: { width: MINI, height: MINI },
  miniInitials: {
    fontSize: 10,
    fontWeight: '800',
    color: theme.textMuted,
  },
});
