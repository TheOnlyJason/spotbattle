-- Cap how many non-spectator players can join a room (host sets maxContestants in rooms.settings).

create or replace function public.join_room(p_code text, p_nickname text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_max int;
  v_cnt int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select
    r.id,
    least(greatest(coalesce(nullif(trim(r.settings->>'maxContestants'), '')::int, 16), 2), 48)
  into v_room_id, v_max
  from public.rooms r
  where upper(trim(r.code)) = upper(trim(p_code))
    and r.status = 'lobby'
  limit 1;

  if v_room_id is null then
    raise exception 'ROOM_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.room_players rp
    where rp.room_id = v_room_id and rp.user_id = auth.uid()
  ) then
    insert into public.room_players (room_id, user_id, nickname)
    values (v_room_id, auth.uid(), trim(p_nickname))
    on conflict (room_id, user_id) do update
      set nickname = excluded.nickname;
    return v_room_id;
  end if;

  select count(*) into v_cnt
  from public.room_players rp
  where rp.room_id = v_room_id
    and coalesce(rp.is_spectator, false) = false;

  if v_cnt >= v_max then
    raise exception 'ROOM_FULL';
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
