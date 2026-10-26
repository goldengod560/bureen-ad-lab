-- Family NFL Picks v0.9.1
-- FUTURE-GAME LOCK INTEGRITY FIX
--
-- Run this ONCE in Supabase -> SQL Editor -> New query.
--
-- PURPOSE
-- A player is allowed to count as "submitted" only while they have a complete
-- pick for EVERY game currently loaded for that week.
--
-- This prevents an old/stale submission marker from making future games lock
-- while another player is still incomplete.
--
-- IMPORTANT: this does NOT reset or delete:
--   picks
--   margins
--   points
--   standings
--   history
--   PINs
--   games
--   overrides
--
-- It may remove ONLY an invalid/stale row from family_submissions when that
-- player does not currently have a complete pick for every game in that week.
-- That is the bad lock flag we are fixing.

create or replace function private.family_submission_is_complete(
  p_season integer,
  p_week integer,
  p_player_id text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select
    exists(
      select 1
      from public.family_submissions s
      where s.season=p_season
        and s.week=p_week
        and s.player_id=p_player_id
    )
    and exists(
      select 1
      from public.family_games g
      where g.season=p_season
        and g.week=p_week
    )
    and not exists(
      select 1
      from public.family_games g
      where g.season=p_season
        and g.week=p_week
        and not exists(
          select 1
          from public.family_picks p
          where p.season=g.season
            and p.week=g.week
            and p.game_id=g.game_id
            and p.player_id=p_player_id
            and p.team is not null
            and p.margin between 1 and 99
        )
    );
$$;

create or replace function private.family_clear_incomplete_submissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season integer;
  v_week integer;
begin
  if TG_OP = 'DELETE' then
    v_season := OLD.season;
    v_week   := OLD.week;
  else
    v_season := NEW.season;
    v_week   := NEW.week;
  end if;

  delete from public.family_submissions s
  where s.season=v_season
    and s.week=v_week
    and not private.family_submission_is_complete(
      s.season,
      s.week,
      s.player_id
    );

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

-- If the loaded schedule changes after somebody submitted, re-check submission validity.
drop trigger if exists family_games_recheck_submissions on public.family_games;
create trigger family_games_recheck_submissions
after insert or update or delete
on public.family_games
for each row
execute function private.family_clear_incomplete_submissions();

-- If a pick is ever removed/invalidated, re-check submission validity too.
drop trigger if exists family_picks_recheck_submissions on public.family_picks;
create trigger family_picks_recheck_submissions
after insert or update or delete
on public.family_picks
for each row
execute function private.family_clear_incomplete_submissions();

-- Clean up any stale incomplete submission marker that already exists NOW.
delete from public.family_submissions s
where not private.family_submission_is_complete(
  s.season,
  s.week,
  s.player_id
);

notify pgrst, 'reload schema';
