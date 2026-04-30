-- Rematch votes, leave/disband, trigger when a game ends.

alter table public.room_players
  add column if not exists rematch_choice text not null default 'idle'
    check (rematch_choice in ('idle', 'pending', 'yes', 'no'));

create or replace function public.rooms_set_rematch_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.phase = 'ended'
     and new.status = 'finished'
     and (old.phase is distinct from 'ended' or old.status is distinct from 'finished')
  then
    update public.room_players
    set rematch_choice = 'pending'
    where room_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_tg_rematch_pending on public.rooms;
create trigger rooms_tg_rematch_pending
after update on public.rooms
for each row
execute function public.rooms_set_rematch_pending();

-- Self-delete from a room; disband if fewer than 2 players remain; reassign host if host leaves.
create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_host uuid;
  v_left_host boolean;
  v_rem int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_room_member(p_room_id, v_uid) then
    raise exception 'not allowed';
  end if;

  select r.host_user_id into v_host
  from public.rooms r
  where r.id = p_room_id
  for update;

  if not found then
    return;
  end if;

  v_left_host := v_host = v_uid;

  delete from public.room_players
  where room_id = p_room_id and user_id = v_uid;

  select count(*)::int into v_rem from public.room_players where room_id = p_room_id;

  if v_rem = 0 or v_rem < 2 then
    delete from public.rooms where id = p_room_id;
    return;
  end if;

  if v_left_host then
    update public.rooms r
    set
      host_user_id = (
        select rp.user_id
        from public.room_players rp
        where rp.room_id = p_room_id
        order by rp.created_at asc
        limit 1
      ),
      updated_at = now()
    where r.id = p_room_id;
  end if;
end;
$$;

revoke all on function public.leave_room(uuid) from public;
grant execute on function public.leave_room(uuid) to anon, authenticated;

-- Vote yes/no on playing again (only while game is ended).
create or replace function public.set_rematch_vote(p_room_id uuid, p_vote text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_room_member(p_room_id, v_uid) then
    raise exception 'not allowed';
  end if;

  if p_vote is null or p_vote not in ('yes', 'no') then
    raise exception 'invalid vote';
  end if;

  if not exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.phase = 'ended' and r.status = 'finished'
  ) then
    raise exception 'not in rematch phase';
  end if;

  update public.room_players rp
  set rematch_choice = p_vote
  where rp.room_id = p_room_id and rp.user_id = v_uid;
end;
$$;

revoke all on function public.set_rematch_vote(uuid, text) from public;
grant execute on function public.set_rematch_vote(uuid, text) to anon, authenticated;

-- When every remaining player voted yes, reset to lobby with fresh empty pools.
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
    current_track = null,
    correct_player_id = null,
    round_started_at = null,
    reveal_started_at = null,
    updated_at = now()
  where id = p_room_id;

  update public.room_players
  set
    score = 0,
    current_vote_player_id = null,
    ready = false,
    rematch_choice = 'idle',
    track_pool = '[]'::jsonb
  where room_id = p_room_id;
end;
$$;

revoke all on function public.try_rematch(uuid) from public;
grant execute on function public.try_rematch(uuid) to anon, authenticated;
