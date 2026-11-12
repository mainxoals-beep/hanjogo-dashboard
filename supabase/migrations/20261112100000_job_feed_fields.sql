-- 오늘의 F&B 채용을 분야별로 나눠 보여주기 위해:
--   1) 분야에 '홀·소믈리에(service)'와 '식품·급식(food)'을 더합니다.
--   2) 분야별로 고를 수 있게 한 번에 내보내는 글 수를 15건에서 40건으로 늘립니다.
-- 거르는 조건(숨김 아님 · 마감 전 또는 상시 · 최근 5일 안에 다시 확인)은 그대로입니다.
alter table public.hanjogo_job_feed drop constraint if exists hanjogo_job_feed_role_group_check;
alter table public.hanjogo_job_feed add constraint hanjogo_job_feed_role_group_check
  check (role_group in ('chef','rnd','bakery','cafe','ops','hotel','md','marketing','service','food','etc'));

create or replace function public.get_hanjogo_job_feed()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', j.id, 'title', j.title, 'company', j.company, 'location', coalesce(j.location, ''),
    'roleGroup', j.role_group, 'career', j.career, 'employment', coalesce(j.employment, ''),
    'summary', coalesce(j.summary, ''), 'closesOn', j.closes_on, 'alwaysOpen', j.always_open,
    'source', j.source_name, 'url', j.source_url, 'postedOn', j.posted_on,
    'verifiedOn', (j.verified_at at time zone 'Asia/Seoul')::date
  ) order by j.posted_on desc, j.closes_on nulls last, j.id desc), '[]'::jsonb)
  from (
    select * from public.hanjogo_job_feed
    where not is_hidden
      and verified_at > now() - interval '5 days'
      and (always_open or closes_on >= (now() at time zone 'Asia/Seoul')::date)
    order by posted_on desc, closes_on nulls last, id desc
    limit 40
  ) j
$fn$;
revoke all on function public.get_hanjogo_job_feed() from public;
grant execute on function public.get_hanjogo_job_feed() to anon, authenticated;
