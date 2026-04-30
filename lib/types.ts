export type SongSource = 'playlists' | 'liked';

export type RoomSettings = {
  rounds: number;
  songSource: SongSource;
  secondsPerRound: number;
  deepCuts: boolean;
};

export type GameTrack = {
  id: string;
  name: string;
  artists: string;
  imageUrl: string | null;
  /** Spotify often returns null; Deezer may fill this via `isrc` (see `enrichTracksWithDeezerPreviews`). */
  previewUrl: string | null;
  /** International Standard Recording Code from Spotify, used to match Deezer preview MP3s. */
  isrc?: string | null;
  /** When sampled from the owner's Spotify playlists (shown on reveal). */
  sourcePlaylistId?: string | null;
  sourcePlaylistName?: string | null;
};

export type RoomRow = {
  id: string;
  code: string;
  host_user_id: string;
  status: 'lobby' | 'playing' | 'finished';
  phase: 'lobby' | 'building' | 'guess' | 'reveal' | 'ended';
  settings: RoomSettings;
  round_number: number;
  played_track_ids: string[];
  current_track: GameTrack | null;
  correct_player_id: string | null;
  round_started_at: string | null;
  /** Server sets when entering reveal; used for auto-advance after dwell. */
  reveal_started_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Set when a game ends; `idle` during play / lobby after rematch. */
export type RematchChoice = 'idle' | 'pending' | 'yes' | 'no';

export type RoomPlayerRow = {
  id: string;
  room_id: string;
  user_id: string;
  nickname: string;
  spotify_display_name: string | null;
  track_pool: GameTrack[];
  score: number;
  ready: boolean;
  current_vote_player_id: string | null;
  rematch_choice: RematchChoice;
};
