-- Auto reveal + advance rounds without host-only room updates (any member can call RPCs).

alter table public.rooms
  add column if not exists reveal_started_at timestamptz;

-- Score + reveal when guess timer has expired (idempotent if already reveal).
create or replace function public.finalize_guess_phase(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_sec int;
  v_deadline timestamptz;
begin
  if auth.uid() is null or not public.is_room_member(p_room_id, auth.uid()) then
    raise exception 'not allowed';
  end if;

  select
    id,
    phase,
    correct_player_id,
    settings,
    round_started_at
  into r
  from public.rooms
  where id = p_room_id
  for update;

  if not found or r.phase is distinct from 'guess' or r.correct_player_id is null then
    return;
  end if;

  if r.round_started_at is null then
    return;
  end if;

  v_sec := coalesce(nullif(trim(r.settings->>'secondsPerRound'), '')::int, 20);
  v_sec := greatest(5, least(30, v_sec));
  v_deadline := r.round_started_at + make_interval(secs => v_sec);

  if clock_timestamp() < v_deadline then
    return;
  end if;

  update public.room_players rp
  set score = rp.score + 100
  from public.rooms rm
  where rm.id = p_room_id
    and rp.room_id = rm.id
    and rm.phase = 'guess'
    and rp.current_vote_player_id = rm.correct_player_id;

  update public.rooms
  set
    phase = 'reveal',
    reveal_started_at = clock_timestamp(),
    updated_at = now()
  where id = p_room_id
    and phase = 'guess';
end;
$$;

revoke all on function public.finalize_guess_phase(uuid) from public;
grant execute on function public.finalize_guess_phase(uuid) to anon, authenticated;

-- After reveal dwell (3s), pick next track or end game (idempotent).
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
  set current_vote_player_id = null
  where room_id = p_room_id;

  with
  expanded as (
    select
      rp.id as owner_id,
      elem as track
    from public.room_players rp,
         lateral jsonb_array_elements(coalesce(rp.track_pool, '[]'::jsonb)) as elem
    where rp.room_id = p_room_id
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
