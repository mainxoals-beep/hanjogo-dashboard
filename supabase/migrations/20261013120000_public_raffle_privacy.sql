begin;
-- Public raffle payload (schedule.html only):
-- - storyEntries / winnerKeys are never sent (the public page does not use them).
-- - candidates (full roster for the name animation) are sent only while a draw is still revealing.
-- - From 2026-10-19 00:00 KST, winner names are masked on the server (e.g. 김태민 -> 김*민).
create or replace function raffle_private.mask_name(p text)
returns text language sql immutable set search_path='' as $fn$
  select case when n<=1 then s when n=2 then left(s,1)||'*' else left(s,1)||repeat('*',n-2)||right(s,1) end
  from (select s,char_length(s) n from (select regexp_replace(regexp_replace(coalesce(p,''),'\(.*?\)','','g'),'\s+','','g') s) a) b
$fn$;
create or replace function raffle_private.mask_person(p jsonb)
returns jsonb language sql immutable set search_path='' as $fn$
  select case when jsonb_typeof(p)='object' and p ? 'name'
    then jsonb_set(p,'{name}',to_jsonb(raffle_private.mask_name(p->>'name'))) else p end
$fn$;
revoke all on function raffle_private.mask_name(text) from public,anon,authenticated;
revoke all on function raffle_private.mask_person(jsonb) from public,anon,authenticated;

create or replace function public.get_hanjogo_story_raffle()
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare c jsonb; u timestamptz; live jsonb; history jsonb;
  now_ms bigint:=floor(extract(epoch from now())*1000);
  after_event boolean:=now()>=timestamptz '2026-10-19 00:00:00+09';
begin
  select data->'raffleCenter',updated_at into c,u from public.dashboard_state where id='main' limit 1;
  c:=coalesce(c,'{}'::jsonb);
  live:=coalesce(c->'live',jsonb_build_object('status','idle','drawId','','winner',null));
  history:=case when jsonb_typeof(c->'history')='array' then c->'history' else '[]'::jsonb end;
  if not (live->>'status'='drawing' and coalesce((live->>'revealAt')::numeric,0)>now_ms) then
    live:=jsonb_set(live,'{candidates}','[]'::jsonb);
  end if;
  if after_event then
    live:=jsonb_set(live,'{candidates}','[]'::jsonb);
    if live ? 'winner' then live:=jsonb_set(live,'{winner}',raffle_private.mask_person(live->'winner')); end if;
    if jsonb_typeof(live->'winners')='array' then
      live:=jsonb_set(live,'{winners}',(select coalesce(jsonb_agg(raffle_private.mask_person(w) order by o),'[]'::jsonb)
        from jsonb_array_elements(live->'winners') with ordinality t(w,o)));
    end if;
    history:=(select coalesce(jsonb_agg(case when h ? 'winner' then jsonb_set(h,'{winner}',raffle_private.mask_person(h->'winner')) else h end order by o),'[]'::jsonb)
      from jsonb_array_elements(history) with ordinality t(h,o));
  end if;
  return jsonb_build_object(
    'storyRaffle',jsonb_build_object('instagramHandle',coalesce(c->'instagramHandle','"@kcas_archived"'::jsonb),'history',history,'live',live,'namesMasked',after_event),
    'updatedAt',to_jsonb(u));
end $fn$;
revoke all on function public.get_hanjogo_story_raffle() from public;
grant execute on function public.get_hanjogo_story_raffle() to anon, authenticated;
commit;
