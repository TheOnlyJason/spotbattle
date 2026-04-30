-- Profile image URL from Spotify GET /v1/me (images[].url); optional, may be null.
alter table public.room_players
  add column if not exists spotify_image_url text;
