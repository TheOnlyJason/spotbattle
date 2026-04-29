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
  previewUrl: string;
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
  created_at: string;
  updated_at: string;
};

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
};
