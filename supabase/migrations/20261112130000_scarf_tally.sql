-- 스카프 색 투표 결과를 팝업에서 바로바로 보여주기 위한 집계 함수.
-- 기수·색별 개수만 내보내고, 누가 골랐는지(이메일)는 내보내지 않습니다.
-- 로그인한 사용자(authenticated)만 부를 수 있습니다.
create or replace function public.get_hanjogo_scarf_tally()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('generation', t.generation, 'color', t.color, 'other', t.other, 'count', t.n)
    order by t.generation, t.n desc), '[]'::jsonb)
  from (
    select generation, color,
           case when color = 'other' then nullif(btrim(other_text), '') end as other,
           count(*)::int as n
    from public.hanjogo_scarf_votes
    group by 1, 2, 3
  ) t
$fn$;
revoke all on function public.get_hanjogo_scarf_tally() from public, anon;
grant execute on function public.get_hanjogo_scarf_tally() to authenticated;
