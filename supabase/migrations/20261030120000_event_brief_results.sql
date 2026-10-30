-- 참가자가 아닌 사람에게도 만족도 결과 요약(문항별 평균, 선택 문항 응답 수)을 보여줍니다.
-- 응답이 5건 이상일 때만 내보내고, 자유 의견(text 문항)과 응답자 정보는 담지 않습니다.
-- 결산 총액(수입·지출·잔액)은 public_summary에 관리자가 넣은 값을 그대로 돌려줍니다.
create or replace function public.get_hanjogo_event_brief(p_event_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ev record;
  n int;
  avg_score numeric;
  res jsonb;
begin
  select * into ev from public.hanjogo_event_info where event_key = p_event_key and published;
  if not found then return null; end if;
  select count(*) into n from public.hanjogo_event_survey_responses where event_key = p_event_key;
  if n >= 5 then
    select round(avg(x.val), 1) into avg_score from (
      select (a.value)::numeric as val
      from public.hanjogo_event_survey_responses r
      cross join lateral jsonb_each_text(r.answers) a
      where r.event_key = p_event_key
        and a.key in (select q ->> 'id' from jsonb_array_elements(ev.survey_questions) q where q ->> 'type' = 'rating')
        and a.value ~ '^[1-5]$'
    ) x;
    select jsonb_build_object(
      'responseCount', n,
      'overall', avg_score,
      'ratings', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q ->> 'id', 'label', q ->> 'label',
          'average', (select round(avg((r.answers ->> (q ->> 'id'))::numeric), 1)
                      from public.hanjogo_event_survey_responses r
                      where r.event_key = p_event_key and (r.answers ->> (q ->> 'id')) ~ '^[1-5]$')
        ) order by o)
        from jsonb_array_elements(ev.survey_questions) with ordinality s(q, o)
        where q ->> 'type' = 'rating'), '[]'::jsonb),
      'choices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q ->> 'id', 'label', q ->> 'label', 'multi', q ->> 'type' = 'multi',
          'options', (select jsonb_agg(jsonb_build_object('label', opt, 'count',
                        (select count(*) from public.hanjogo_event_survey_responses r
                         where r.event_key = p_event_key and r.answers -> (q ->> 'id') @> to_jsonb(opt))) order by oo)
                      from jsonb_array_elements_text(q -> 'options') with ordinality u(opt, oo))
        ) order by o)
        from jsonb_array_elements(ev.survey_questions) with ordinality s(q, o)
        where q ->> 'type' in ('choice', 'multi')), '[]'::jsonb)
    ) into res;
  end if;
  return jsonb_build_object(
    'title', ev.title,
    'eventDate', ev.event_date,
    'summary', ev.public_summary,
    'responseCount', case when n >= 5 then n end,
    'satisfaction', avg_score,
    'results', res
  );
end;
$$;
revoke all on function public.get_hanjogo_event_brief(text) from public;
grant execute on function public.get_hanjogo_event_brief(text) to anon, authenticated;
