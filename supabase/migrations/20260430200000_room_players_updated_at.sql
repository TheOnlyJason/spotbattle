-- Init schema omitted room_players.updated_at; RPCs (advance_from_reveal, promote_spectator_to_player, etc.) set it.
alter table public.room_players
  add column if not exists updated_at timestamptz not null default now();
