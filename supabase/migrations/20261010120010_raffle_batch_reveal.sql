-- Pending explicit approval. This file must not be run automatically.
begin;
-- Merge the two parts without losing already recorded draw IDs.
do $merge$
declare pair text[]; a public.raffle_prize_plan; b public.raffle_prize_plan;
begin
  perform 1 from public.dashboard_state where id='main' for update;
  if exists(select 1 from public.dashboard_state where id='main'
    and data#>>'{raffleCenter,live,status}'='drawing'
    and coalesce((data#>>'{raffleCenter,live,revealAt}')::bigint,0)>extract(epoch from clock_timestamp())*1000)
    then raise exception '추첨 진행 중에는 배분표를 변경할 수 없습니다.'; end if;
  foreach pair slice 1 in array array[
    ['event-prize-2','event-prize-6'],['event-prize-3','event-prize-7'],['event-prize-5','event-prize-1']]
  loop
    select * into a from public.raffle_prize_plan where id=pair[1] for update;
    if not found then raise exception '경품 배분표를 확인해주세요.'; end if;
    select * into b from public.raffle_prize_plan where id=pair[2] for update;
    if found then
      if a.prize<>b.prize or a.units_per_winner<>b.units_per_winner or a.owner_id<>b.owner_id
        then raise exception '동일 경품 정보가 일치하지 않습니다.'; end if;
      update public.raffle_prize_plan set winners=a.winners+b.winners,draw_ids=a.draw_ids||b.draw_ids where id=a.id;
      delete from public.raffle_prize_plan where id=b.id;
    end if;
  end loop;
  update public.raffle_prize_plan set
    part=case when id in ('event-prize-2','event-prize-3','event-prize-4','event-prize-8') then 1 else 2 end,
    position=case id when 'event-prize-2' then 1 when 'event-prize-3' then 2 when 'event-prize-4' then 3
      when 'event-prize-8' then 4 when 'event-prize-5' then 1 when 'event-story-pending' then 2 when 'event-prize-9' then 3 end
  where id in ('event-prize-2','event-prize-3','event-prize-4','event-prize-8','event-prize-5','event-story-pending','event-prize-9');
end $merge$;

-- The existing private selector is reused; eligibility is not sent to the client.
create or replace function raffle_private.draw_batch(p_plan_id text,p_previous_draw_id text,p_test boolean,p_test_keys text[])
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare plan public.raffle_prize_plan; c jsonb; result jsonb; chosen jsonb; people jsonb:='[]';
  keys text[]:=coalesce(p_test_keys,'{}'); previous text; n int; now_ms bigint; live jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.raffle_prize_plan where owner_id=auth.uid())
    then raise exception '관리자 인증이 필요합니다.'; end if;
  select data->'raffleCenter' into c from public.dashboard_state where id='main' for update;
  if not found then raise exception '추첨 정보를 확인해주세요.'; end if;
  select * into plan from public.raffle_prize_plan where id=p_plan_id and owner_id=auth.uid() for update;
  if not found or p_plan_id not in ('event-prize-2','event-prize-3','event-prize-5')
    then raise exception '일괄 추첨 경품을 선택해주세요.'; end if;
  if not p_test and c#>>'{live,batch,requestPrevious}'=coalesce(p_previous_draw_id,'')
     and c#>>'{live,batch,planId}'=p_plan_id then return jsonb_build_object('center',c); end if;
  n:=plan.winners-cardinality(plan.draw_ids);
  if n<1 or n>5 then raise exception '남은 경품 수량을 확인해주세요.'; end if;
  previous:=coalesce(c#>>'{live,drawId}','');
  if not p_test and previous<>coalesce(p_previous_draw_id,'') then raise exception '추첨 상태가 변경되었습니다. 다시 확인해주세요.'; end if;
  for i in 1..n loop
    -- Each selection sees the preceding winners. Any failure rolls back the whole RPC.
    result:=raffle_private.draw('confirmed',plan.prize,plan.id,previous,p_test,keys);
    if p_test then
      chosen:=result->'winner';
      keys:=array_append(keys,lower(regexp_replace(chosen->>'name','[[:space:]]+','','g'))||'|'||(chosen->>'generation'));
    else
      c:=result->'center';chosen:=c#>'{live,winner}';previous:=c#>>'{live,drawId}';
      if i<n then
        -- Only the final committed state is read by public-page notifications.
        update public.dashboard_state set data=jsonb_set(data,'{raffleCenter,live,revealAt}','0') where id='main';
      end if;
    end if;
    people:=people||jsonb_build_array(chosen);
  end loop;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);
  live:=jsonb_build_object('status','drawing','drawId',case when p_test then 'test-'||gen_random_uuid()::text else previous end,
    'prize',plan.prize,'pool','confirmed','poolLabel',case when p_test then '내부 테스트 · 실제 당첨 아님' else '전체 참여자' end,
    'startedAt',now_ms,'revealAt',now_ms+7000+6000*n,'winner',people->0,'winners',people,
    'candidates',case when p_test then people else coalesce(c#>'{live,candidates}','[]') end,
    'batch',jsonb_build_object('elapsed',0,'anchor',now_ms,'paused',false,'version',0,
      'planId',p_plan_id,'requestPrevious',coalesce(p_previous_draw_id,'')));
  if p_test then return jsonb_build_object('live',live); end if;
  c:=jsonb_set(c,'{live}',live);
  update public.dashboard_state set data=jsonb_set(data,'{raffleCenter}',c),updated_at=now() where id='main';
  return jsonb_build_object('center',c);
end $fn$;
revoke all on function raffle_private.draw_batch(text,text,boolean,text[]) from public,anon;
grant execute on function raffle_private.draw_batch(text,text,boolean,text[]) to authenticated;
create or replace function public.perform_raffle_batch(p_plan_id text,p_previous_draw_id text,p_test boolean default false,p_test_keys text[] default '{}')
returns jsonb language sql security invoker set search_path='' as $fn$
select raffle_private.draw_batch(p_plan_id,p_previous_draw_id,p_test,p_test_keys)
$fn$;
revoke all on function public.perform_raffle_batch(text,text,boolean,text[]) from public,anon;
grant execute on function public.perform_raffle_batch(text,text,boolean,text[]) to authenticated;

create or replace function raffle_private.control_batch(p_draw_id text,p_version int,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare c jsonb; live jsonb; b jsonb; now_ms bigint; elapsed_ms bigint; total bigint; paused boolean;
begin
  if auth.uid() is null or not exists(select 1 from public.raffle_prize_plan where owner_id=auth.uid())
    then raise exception '관리자 인증이 필요합니다.'; end if;
  select data->'raffleCenter' into c from public.dashboard_state where id='main' for update;
  live:=c->'live';b:=live->'batch';
  if b is null or (live->>'drawId') is distinct from p_draw_id or (b->>'version')::int is distinct from p_version
    then raise exception '공개 상태가 변경되었습니다. 새로고침 후 확인해주세요.'; end if;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);paused:=(b->>'paused')::boolean;
  total:=7000+6000*jsonb_array_length(live->'winners');
  elapsed_ms:=least(total,(b->>'elapsed')::bigint+case when paused then 0 else greatest(0,now_ms-(b->>'anchor')::bigint) end);
  if p_action='pause' then paused:=true;
  elsif p_action='resume' then paused:=false;
  elsif p_action='next' then
    if elapsed_ms<7000 then elapsed_ms:=7000;
    elsif elapsed_ms<total then elapsed_ms:=least(total,7000+((elapsed_ms-7000)/3000+1)*3000); end if;
  else raise exception '공개 동작을 확인해주세요.'; end if;
  b:=b||jsonb_build_object('elapsed',elapsed_ms,'anchor',now_ms,'paused',paused,'version',p_version+1);
  live:=live||jsonb_build_object('batch',b,'revealAt',case when paused and elapsed_ms<total then 8640000000000000 else now_ms+total-elapsed_ms end);
  c:=jsonb_set(c,'{live}',live);
  update public.dashboard_state set data=jsonb_set(data,'{raffleCenter}',c),updated_at=now() where id='main';
  return jsonb_build_object('center',c);
end $fn$;
revoke all on function raffle_private.control_batch(text,int,text) from public,anon;
grant execute on function raffle_private.control_batch(text,int,text) to authenticated;
create or replace function public.control_raffle_batch(p_draw_id text,p_version int,p_action text)
returns jsonb language sql security invoker set search_path='' as $fn$
select raffle_private.control_batch(p_draw_id,p_version,p_action)
$fn$;
revoke all on function public.control_raffle_batch(text,int,text) from public,anon;
grant execute on function public.control_raffle_batch(text,int,text) to authenticated;
commit;
