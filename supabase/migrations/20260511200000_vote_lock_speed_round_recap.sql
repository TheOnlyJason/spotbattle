-- Vote lock (no change/clear in guess), vote_submitted_at for speed scoring, round recap on reveal.

alter table public.room_players
  add column if not exists vote_submitted_at timestamptz;

alter table public.rooms
  add column if not exists round_recap jsonb not null default '[]'::jsonb;

create or replace function public.room_players_vote_lock_and_timestamp()
returns trigger
language plpgsql
as $fn$
declare
  v_phase text;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if coalesce(current_setting('app.skip_room_player_vote_enforcement', true), '') = 'on' then
    return new;
  end if;

  select r.phase into v_phase
  from public.rooms r
  where r.id = new.room_id;

  if old.current_vote_player_id is not null
     and new.current_vote_player_id is distinct from old.current_vote_player_id then
    if v_phase in ('lobby', 'building') and new.current_vote_player_id is null then
      new.vote_submitted_at := null;
      return new;
    end if;
    raise exception 'VOTE_LOCKED' using errcode = 'P0001';
  end if;

  if old.current_vote_player_id is null
     and new.current_vote_player_id is not null
     and new.vote_submitted_at is null then
    new.vote_submitted_at := clock_timestamp();
  end if;

  return new;
end;
$fn$;

drop trigger if exists room_players_tg_vote_lock on public.room_players;
create trigger room_players_tg_vote_lock
before update of current_vote_player_id, vote_submitted_at on public.room_players
for each row
execute function public.room_players_vote_lock_and_timestamp();

-- Score + reveal when guess timer has expired (speed bonus 25–100, round recap).
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
  v_round_dur numeric;
  v_entry jsonb;
  v_ids jsonb;
  rp record;
  v_elapsed numeric;
  v_speed numeric;
  v_pts int;
begin
  if auth.uid() is null or not public.is_room_member(p_room_id, auth.uid()) then
    raise exception 'not allowed';
  end if;

  select
    id,
    phase,
    correct_player_id,
    settings,
    round_started_at,
    round_number,
    current_track
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

  v_round_dur := greatest(
    1.0,
    extract(epoch from (r.round_started_at + make_interval(secs => v_sec) - r.round_started_at))::numeric
  );

  for rp in
    select * from public.room_players where room_id = p_room_id
  loop
    if coalesce(rp.is_spectator, false) then
      continue;
    end if;

    if rp.current_vote_player_id is null
       or rp.current_vote_player_id is distinct from r.correct_player_id then
      continue;
    end if;

    v_elapsed := extract(epoch from (
      coalesce(rp.vote_submitted_at, r.round_started_at + make_interval(secs => v_sec))
      - r.round_started_at
    ));
    if v_elapsed < 0 then
      v_elapsed := 0;
    end if;
    if v_elapsed > v_round_dur then
      v_elapsed := v_round_dur;
    end if;

    v_speed := 1.0 - (v_elapsed / v_round_dur);
    if v_speed < 0 then
      v_speed := 0;
    end if;
    if v_speed > 1 then
      v_speed := 1;
    end if;

    v_pts := floor(25 + 75 * v_speed)::int;

    update public.room_players
    set score = score + v_pts
    where id = rp.id;
  end loop;

  select coalesce(jsonb_agg(rp.id), '[]'::jsonb)
  into v_ids
  from public.room_players rp
  where rp.room_id = p_room_id
    and coalesce(rp.is_spectator, false) = false
    and rp.current_vote_player_id is not null
    and rp.current_vote_player_id = r.correct_player_id;

  v_entry := jsonb_build_object(
    'round', r.round_number,
    'trackId', coalesce(r.current_track->>'id', ''),
    'trackName', coalesce(r.current_track->>'name', 'Unknown'),
    'correctVoterIds', v_ids
  );

  update public.rooms
  set
    phase = 'reveal',
    reveal_started_at = clock_timestamp(),
    round_recap = coalesce(round_recap, '[]'::jsonb) || jsonb_build_array(v_entry),
    updated_at = now()
  where id = p_room_id
    and phase = 'guess';
end;
$$;

revoke all on function public.finalize_guess_phase(uuid) from public;
grant execute on function public.finalize_guess_phase(uuid) to anon, authenticated;

-- After reveal dwell: clear votes + timestamps (skip vote trigger).
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

  perform set_config('app.skip_room_player_vote_enforcement', 'on', true);
  update public.room_players
  set
    current_vote_player_id = null,
    vote_submitted_at = null,
    updated_at = now()
  where room_id = p_room_id;
  perform set_config('app.skip_room_player_vote_enforcement', 'off', true);

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

-- Rematch: clear recap and vote timestamps.
create or replace function public.try_rematch(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
  v_yes int;
begin
  if auth.uid() is null or not public.is_room_member(p_room_id, auth.uid()) then
    raise exception 'not allowed';
  end if;

  perform 1
  from public.rooms r
  where r.id = p_room_id and r.phase = 'ended' and r.status = 'finished'
  for update;

  if not found then
    return;
  end if;

  select count(*)::int, count(*) filter (where rp.rematch_choice = 'yes')::int
  into v_total, v_yes
  from public.room_players rp
  where rp.room_id = p_room_id;

  if v_total < 1 or v_yes <> v_total then
    return;
  end if;

  update public.rooms
  set
    status = 'lobby',
    phase = 'lobby',
    round_number = 0,
    played_track_ids = '[]'::jsonb,
    round_recap = '[]'::jsonb,
    current_track = null,
    correct_player_id = null,
    round_started_at = null,
    reveal_started_at = null,
    updated_at = now()
  where id = p_room_id;

  perform set_config('app.skip_room_player_vote_enforcement', 'on', true);
  update public.room_players
  set
    score = 0,
    current_vote_player_id = null,
    vote_submitted_at = null,
    ready = false,
    rematch_choice = 'idle',
    track_pool = '[]'::jsonb,
    updated_at = now()
  where room_id = p_room_id;
  perform set_config('app.skip_room_player_vote_enforcement', 'off', true);
end;
$$;

revoke all on function public.try_rematch(uuid) from public;
grant execute on function public.try_rematch(uuid) to anon, authenticated;
