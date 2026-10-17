begin;
-- 추첨 진행자 추가: 경품 계획 소유자(관리자) 외에, 기간을 정해 다른 계정도 추첨을 진행할 수 있게 합니다.
-- 진행자 이메일은 이 파일에 적지 않고 운영 DB의 raffle_private.operators 에만 넣습니다.
create table if not exists raffle_private.operators (
  email text primary key check (email = lower(btrim(email))),
  expires_at timestamptz not null
);
-- 정책 없이 RLS만 켜 둬서 함수 외에는 읽지도 쓰지도 못합니다(anon은 이 스키마에 접근도 못 합니다).
alter table raffle_private.operators enable row level security;

create or replace function raffle_private.is_operator()
returns boolean language sql stable security definer set search_path='' as $fn$
  select auth.uid() is not null and (
    exists (select 1 from public.raffle_prize_plan where owner_id = auth.uid())
    or exists (
      select 1 from raffle_private.operators o join auth.users u on lower(u.email) = o.email
      where u.id = auth.uid() and o.expires_at > now()
    )
  )
$fn$;
grant execute on function raffle_private.is_operator() to authenticated;

create policy "operator_read" on public.raffle_prize_plan for select to authenticated
  using ((select raffle_private.is_operator()));

-- 일괄 추첨 시작·공개 제어도 관리자 대신 raffle_private.is_operator() 로 확인합니다.
-- (한 명씩 뽑는 raffle_private.draw 도 같은 확인으로 바꿨습니다. 그 함수 본문은 저장소에 두지 않습니다.)
CREATE OR REPLACE FUNCTION raffle_private.draw_batch(p_plan_id text, p_previous_draw_id text, p_test boolean, p_test_keys text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare plan public.raffle_prize_plan; c jsonb; result jsonb; chosen jsonb; people jsonb:='[]';
  keys text[]:=coalesce(p_test_keys,'{}'); previous text; n int; now_ms bigint; live jsonb;
begin
  if not raffle_private.is_operator()
    then raise exception '관리자 인증이 필요합니다.'; end if;
  select data->'raffleCenter' into c from public.dashboard_state where id='main' for update;
  if not found then raise exception '추첨 정보를 확인해주세요.'; end if;
  select * into plan from public.raffle_prize_plan where id=p_plan_id for update;
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
    'startedAt',now_ms,'revealAt',now_ms+9000+17000*n,'winner',people->0,'winners',people,
    'candidates',case when p_test then people else coalesce(c#>'{live,candidates}','[]') end,
    'batch',jsonb_build_object('elapsed',0,'anchor',now_ms,'paused',false,'version',0,
      'planId',p_plan_id,'requestPrevious',coalesce(p_previous_draw_id,'')));
  if p_test then return jsonb_build_object('live',live); end if;
  c:=jsonb_set(c,'{live}',live);
  update public.dashboard_state set data=jsonb_set(data,'{raffleCenter}',c),updated_at=now() where id='main';
  return jsonb_build_object('center',c);
end $function$
;

CREATE OR REPLACE FUNCTION raffle_private.control_batch(p_draw_id text, p_version integer, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c jsonb; live jsonb; b jsonb; now_ms bigint; elapsed_ms bigint; total bigint; paused boolean;
begin
  if not raffle_private.is_operator()
    then raise exception '관리자 인증이 필요합니다.'; end if;
  select data->'raffleCenter' into c from public.dashboard_state where id='main' for update;
  live:=c->'live';b:=live->'batch';
  if b is null or (live->>'drawId') is distinct from p_draw_id or (b->>'version')::int is distinct from p_version
    then raise exception '공개 상태가 변경되었습니다. 새로고침 후 확인해주세요.'; end if;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);paused:=(b->>'paused')::boolean;
  total:=9000+17000*jsonb_array_length(live->'winners');
  elapsed_ms:=least(total,(b->>'elapsed')::bigint+case when paused then 0 else greatest(0,now_ms-(b->>'anchor')::bigint) end);
  if p_action='pause' then paused:=true;
  elsif p_action='resume' then paused:=false;
  elsif p_action='next' then
    if elapsed_ms<9000 then elapsed_ms:=9000;
    elsif elapsed_ms<total then elapsed_ms:=least(total,9000+((elapsed_ms-9000)/17000)*17000+
      case when (elapsed_ms-9000)%17000<3000 then 3000
           when (elapsed_ms-9000)%17000<10000 then 10000 else 17000 end); end if;
  else raise exception '공개 동작을 확인해주세요.'; end if;
  b:=b||jsonb_build_object('elapsed',elapsed_ms,'anchor',now_ms,'paused',paused,'version',p_version+1);
  live:=live||jsonb_build_object('batch',b,'revealAt',case when paused and elapsed_ms<total then 8640000000000000 else now_ms+total-elapsed_ms end);
  c:=jsonb_set(c,'{live}',live);
  update public.dashboard_state set data=jsonb_set(data,'{raffleCenter}',c),updated_at=now() where id='main';
  return jsonb_build_object('center',c);
end $function$
;
commit;
