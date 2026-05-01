-- Spectators (stream/TV), exclude spectators from track pools, delete policies.

alter table public.room_players
  add column if not exists is_spectator boolean not null default false;

-- Join as spectator any time the room exists (lobby / playing / finished).
create or replace function public.join_room_spectator(p_code text, p_nickname text)
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
    and r.status in ('lobby', 'playing', 'finished')
  limit 1;

  if v_room_id is null then
    raise exception 'ROOM_NOT_FOUND';
  end if;

  insert into public.room_players (room_id, user_id, nickname, is_spectator, track_pool, ready)
  values (v_room_id, auth.uid(), trim(p_nickname), true, '[]'::jsonb, false)
  on conflict (room_id, user_id) do update
  set nickname = excluded.nickname;

  return v_room_id;
end;
$$;

revoke all on function public.join_room_spectator(text, text) from public;
grant execute on function public.join_room_spectator(text, text) to anon, authenticated;

-- Spectator becomes a player between games (lobby only).
create or replace function public.promote_spectator_to_player(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_room_member(p_room_id, auth.uid()) then
    raise exception 'not allowed';
  end if;

  if not exists (
    select 1 from public.rooms r
    where r.id = p_room_id
      and r.phase = 'lobby'
      and r.status = 'lobby'
  ) then
    raise exception 'LOBBY_ONLY';
  end if;

  update public.room_players rp
  set is_spectator = false, updated_at = now()
  where rp.room_id = p_room_id
    and rp.user_id = auth.uid()
    and rp.is_spectator = true;
end;
$$;

revoke all on function public.promote_spectator_to_player(uuid) from public;
grant execute on function public.promote_spectator_to_player(uuid) to anon, authenticated;

-- Exclude spectators from random track pool (same logic as app playableEntries).
create or replace function public.advance_from_reveal(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_rounds int;
  v_deep boolean;
  v_next int;
  v_current_id text;
  v_played jsonb;
  v_pick record;
begin
  if auth.uid() is null or not public.is_room_member(p_room_id, auth.uid()) then
    raise exception 'not allowed';
  end if;

  select *
  into r
  from public.rooms
  where id = p_room_id
  for update;

  if not found or r.phase is distinct from 'reveal' then
    return;
  end if;

  if r.reveal_started_at is null or clock_timestamp() < r.reveal_started_at + interval '3 seconds' then
    return;
  end if;

  v_rounds := coalesce(nullif(trim(r.settings->>'rounds'), '')::int, 10);
  v_rounds := greatest(5, least(20, v_rounds));
  v_deep := coalesce((r.settings->>'deepCuts')::boolean, true);

  v_current_id := r.current_track->>'id';
  v_played := coalesce(r.played_track_ids, '[]'::jsonb);
  if v_current_id is not null and length(trim(v_current_id)) > 0 then
    v_played := v_played || to_jsonb(v_current_id);
  end if;

  v_next := coalesce(r.round_number, 0) + 1;

  if v_next > v_rounds then
    update public.rooms
    set
      phase = 'ended',
      status = 'finished',
      round_number = v_next,
      played_track_ids = v_played,
      current_track = null,
      correct_player_id = null,
      round_started_at = null,
      reveal_started_at = null,
      updated_at = now()
    where id = p_room_id
      and phase = 'reveal';
    return;
  end if;

  update public.room_players
  set current_vote_player_id = null, updated_at = now()
  where room_id = p_room_id;

  with
  expanded as (
    select
      rp.id as owner_id,
      elem as track
    from public.room_players rp,
         lateral jsonb_array_elements(coalesce(rp.track_pool, '[]'::jsonb)) as elem
    where rp.room_id = p_room_id
      and coalesce(rp.is_spectator, false) = false
  ),
  eligible as (
    select e.owner_id, e.track
    from expanded e
    where
      coalesce(e.track->>'id', '') <> ''
      and not (v_played ? (e.track->>'id'))
      and (
        not v_deep
        or (
          select count(distinct e2.owner_id)
          from expanded e2
          where (e2.track->>'id') = (e.track->>'id')
        ) = 1
      )
  ),
  picked as (
    select owner_id, track
    from eligible
    order by random()
    limit 1
  )
  select * into v_pick from picked;

  if not found then
    update public.rooms
    set
      phase = 'ended',
      status = 'finished',
      round_number = v_next,
      played_track_ids = v_played,
      current_track = null,
      correct_player_id = null,
      round_started_at = null,
      reveal_started_at = null,
      updated_at = now()
    where id = p_room_id
      and phase = 'reveal';
    return;
  end if;

  update public.rooms
  set
    phase = 'guess',
    round_number = v_next,
    played_track_ids = v_played,
    current_track = v_pick.track,
    correct_player_id = v_pick.owner_id,
    round_started_at = clock_timestamp(),
    reveal_started_at = null,
    updated_at = now()
  where id = p_room_id
    and phase = 'reveal';
end;
$$;

revoke all on function public.advance_from_reveal(uuid) from public;
grant execute on function public.advance_from_reveal(uuid) to anon, authenticated;

drop policy if exists "room_players_delete_self" on public.room_players;
create policy "room_players_delete_self"
  on public.room_players for delete
  using (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "rooms_delete_host" on public.rooms;
create policy "rooms_delete_host"
  on public.rooms for delete
  using (auth.uid() is not null and host_user_id = auth.uid());
