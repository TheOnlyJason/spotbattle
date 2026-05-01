-- spotBattle MVP schema
-- Apply in Supabase SQL Editor or via CLI. Enable Anonymous sign-in in Authentication > Providers.

create extension if not exists "pgcrypto";

-- Rooms
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'lobby'
    check (status in ('lobby', 'playing', 'finished')),
  phase text not null default 'lobby'
    check (phase in ('lobby', 'building', 'guess', 'reveal', 'ended')),
  settings jsonb not null default jsonb_build_object(
    'rounds', 10,
    'songSource', 'playlists',
    'secondsPerRound', 20,
    'deepCuts', true
  ),
  round_number int not null default 0,
  played_track_ids jsonb not null default '[]'::jsonb,
  current_track jsonb,
  correct_player_id uuid,
  round_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  nickname text not null,
  spotify_display_name text,
  track_pool jsonb not null default '[]'::jsonb,
  score int not null default 0,
  ready boolean not null default false,
  current_vote_player_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create index if not exists room_players_room_id_idx on public.room_players (room_id);
create index if not exists rooms_code_idx on public.rooms (code);

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;

-- Idempotent: safe to re-run after a partial apply
drop policy if exists "rooms_select_member_or_host" on public.rooms;
drop policy if exists "rooms_insert_as_host" on public.rooms;
drop policy if exists "rooms_update_host" on public.rooms;
drop policy if exists "room_players_select_roommates" on public.room_players;
drop policy if exists "room_players_insert_self" on public.room_players;
drop policy if exists "room_players_update_self" on public.room_players;
drop policy if exists "room_players_update_by_host" on public.room_players;

-- Avoid RLS infinite recursion: never SELECT room_players from inside a room_players policy.
-- This helper runs as definer and bypasses RLS for the membership lookup only.
create or replace function public.is_room_member(p_room_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.room_players rp
    where rp.room_id = p_room_id
      and rp.user_id = p_uid
  );
$$;

revoke all on function public.is_room_member(uuid, uuid) from public;
grant execute on function public.is_room_member(uuid, uuid) to anon, authenticated;

-- Rooms: host can insert; members or host can read; host can update
create policy "rooms_select_member_or_host"
  on public.rooms for select
  using (
    auth.uid() is not null
    and (
      host_user_id = auth.uid()
      or public.is_room_member(rooms.id, auth.uid())
    )
  );

create policy "rooms_insert_as_host"
  on public.rooms for insert
  with check (auth.uid() is not null and host_user_id = auth.uid());

create policy "rooms_update_host"
  on public.rooms for update
  using (auth.uid() is not null and host_user_id = auth.uid());

-- Players: see everyone in same room (membership via is_room_member — no self-select)
create policy "room_players_select_roommates"
  on public.room_players for select
  using (public.is_room_member(room_id, auth.uid()));

create policy "room_players_insert_self"
  on public.room_players for insert
  with check (
    auth.uid() is not null
    and user_id = auth.uid()
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and r.status = 'lobby'
    )
  );

create policy "room_players_update_self"
  on public.room_players for update
  using (auth.uid() is not null and user_id = auth.uid());

create policy "room_players_update_by_host"
  on public.room_players for update
  using (
    exists (
      select 1 from public.rooms r
      where r.id = room_players.room_id and r.host_user_id = auth.uid()
    )
  );

-- Join by room code without prior membership (bypasses chicken/egg on RLS)
create or replace function public.join_room(p_code text, p_nickname text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select r.id into v_room_id
  from public.rooms r
  where upper(trim(r.code)) = upper(trim(p_code))
    and r.status = 'lobby'
  limit 1;

  if v_room_id is null then
    raise exception 'ROOM_NOT_FOUND';
  end if;

  insert into public.room_players (room_id, user_id, nickname)
  values (v_room_id, auth.uid(), trim(p_nickname))
  on conflict (room_id, user_id) do update
    set nickname = excluded.nickname;

  return v_room_id;
end;
$$;

revoke all on function public.join_room(text, text) from public;
grant execute on function public.join_room(text, text) to anon, authenticated;

-- Realtime: in Dashboard → Database → Replication, enable `rooms` and `room_players`, or run:
-- alter publication supabase_realtime add table public.rooms;
-- alter publication supabase_realtime add table public.room_players;
-- alter table public.rooms replica identity full;
-- alter table public.room_players replica identity full;
