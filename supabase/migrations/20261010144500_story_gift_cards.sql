begin;
do $plan$
declare item public.raffle_prize_plan;
begin
  perform 1 from public.dashboard_state where id='main' for update;
  select * into item from public.raffle_prize_plan where id='event-story-pending' for update;
  if not found then raise exception '스토리 경품 배분표가 없습니다.'; end if;
  if cardinality(item.draw_ids)>0 or exists(select 1 from public.raffle_prize_plan where id='event-story-shinsegae' and cardinality(draw_ids)>0)
    then raise exception '추첨이 시작된 스토리 경품은 변경할 수 없습니다.'; end if;
  update public.raffle_prize_plan set prize='스토리 참여 경품 · 올리브영 상품권 5만원',winners=1,part=2,position=2 where id=item.id;
  insert into public.raffle_prize_plan(id,owner_id,part,position,prize,winners,units_per_winner,finale,draw_ids)
    values('event-story-shinsegae',item.owner_id,2,3,'스토리 참여 경품 · 신세계 상품권 5만원',1,1,false,'{}')
    on conflict(id) do update set prize=excluded.prize,winners=1,part=2,position=3;
  update public.raffle_prize_plan set position=4 where id='event-prize-9';
end $plan$;
-- Preserve the existing selector and its eligibility / duplicate rules.
do $selector$
declare definition text;
begin
  definition:=pg_get_functiondef('raffle_private.draw(text,text,text,text,boolean,text[])'::regprocedure);
  if position('plan.id=''event-story-pending''' in definition)>0 then
    definition:=replace(definition,'plan.id=''event-story-pending''','plan.id in (''event-story-pending'',''event-story-shinsegae'')');
    execute definition;
  elsif position('plan.id in (''event-story-pending'',''event-story-shinsegae'')' in definition)=0 then
    raise exception '스토리 추첨 대상 확인 로직을 검토해주세요.';
  end if;
end $selector$;
commit;
