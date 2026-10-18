begin;
-- 추첨 초기화(행사 당일 리허설용). 관리자·추첨 진행자만 실행할 수 있습니다.
--  - mode 'display': 외부 추첨 화면만 대기 상태로 돌립니다(당첨 기록은 그대로).
--  - mode 'all'    : 리허설 결과를 모두 지웁니다. 당첨 기록·당첨자 제외 명단·경품 소진 수량·화면을 처음으로.
--                    잘못 누르지 않도록 확인 문구 '초기화'를 함께 보내야 합니다. 스토리 참여자 명단은 남깁니다.
-- 화면 쪽에서 통째로 저장하지 않고 서버에서 한 번에 바꾸므로, 다른 기기의 오래된 화면과 섞이지 않습니다.
create or replace function raffle_private.reset_raffle(p_mode text, p_confirm text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare c jsonb; idle jsonb;
begin
  if not raffle_private.is_operator() then raise exception '관리자 인증이 필요합니다.'; end if;
  if p_mode not in ('display','all') then raise exception '초기화 방식을 확인해주세요.'; end if;
  if p_mode='all' and coalesce(p_confirm,'')<>'초기화' then raise exception '확인 문구가 맞지 않습니다.'; end if;
  select data->'raffleCenter' into c from public.dashboard_state where id='main' for update;
  if not found then raise exception '추첨 정보를 확인해주세요.'; end if;
  idle:=jsonb_build_object('status','idle','drawId','idle-'||floor(extract(epoch from clock_timestamp())*1000)::bigint,
    'prize','','pool','','poolLabel','','startedAt','','revealAt','','winner',null,'candidates','[]'::jsonb);
  c:=coalesce(c,'{}'::jsonb)||jsonb_build_object('live',idle);
  if p_mode='all' then
    c:=c||jsonb_build_object('history','[]'::jsonb,'winnerKeys','[]'::jsonb);
    update public.raffle_prize_plan set draw_ids='{}';
  end if;
  update public.dashboard_state set data=jsonb_set(data,'{raffleCenter}',c),updated_at=now() where id='main';
  return jsonb_build_object('center',c);
end $fn$;
grant execute on function raffle_private.reset_raffle(text,text) to authenticated;

create or replace function public.reset_raffle(p_mode text, p_confirm text default '')
returns jsonb language sql security invoker set search_path='' as $fn$
  select raffle_private.reset_raffle(p_mode,p_confirm)
$fn$;
grant execute on function public.reset_raffle(text,text) to authenticated;
commit;
