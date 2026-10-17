-- 공개 참가 인원 계산: 협찬 목록에서 이름을 "(N기)" 바로 앞 글자로 읽도록 고칩니다.
-- "박혜림(7기) / 개인 협찬" 줄이 "개인 협찬"이라는 사람으로 세어져 7기가 1명 많게 나오던 문제를 바로잡습니다.
-- 나머지 협찬 줄은 결과가 같습니다. (함수의 다른 부분은 운영 DB의 현재 정의 그대로입니다.)
CREATE OR REPLACE FUNCTION public.get_hanjogo_public_dashboard()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with src as (
    select data, updated_at
    from public.dashboard_state
    where id='main'
    limit 1
  ),
  first_confirmed as (
    select
      p->>'name' as name,
      nullif(regexp_replace(coalesce(p->>'generation',''),'[^0-9]','','g'),'')::int as generation
    from src, jsonb_array_elements(coalesce(src.data->'participantPayments','[]'::jsonb)) p
    where coalesce(p->>'phase','first') <> 'second'
      and p->>'status' in ('paid','exempt')
  ),
  second_confirmed as (
    select
      p->>'name' as name,
      nullif(regexp_replace(coalesce(p->>'generation',''),'[^0-9]','','g'),'')::int as generation
    from src, jsonb_array_elements(coalesce(src.data->'participantPayments','[]'::jsonb)) p
    where p->>'phase'='second'
      and p->>'status' in ('paid','exempt')
  ),
  sponsor_people as (
    select
      -- 이름은 "(N기)" 바로 앞 글자로 읽습니다. "박혜림(7기) / 개인 협찬"처럼 이름이 앞에 와도 맞게 읽힙니다.
      trim(coalesce(
        substring(s->>'name' from '([^/(]+?)\s*\([0-9]+\s*기\)'),
        nullif(substring(regexp_replace(s->>'name','^.* / ','') from '^([^/(]+)'),''),
        regexp_replace(s->>'name','^.* / ','')
      )) as name,
      nullif(substring(s->>'name' from '\(([0-9]+)\s*기\)'),'')::int as generation
    from src, jsonb_array_elements(coalesce(src.data->'sponsors','[]'::jsonb)) s
  ),
  fixed_committee_people(name,generation) as (
    values
      ('김태민',2),('박혜림',7),('안지현',9),('이민주',10),('이예린',18),('주보근',20),
      ('김미주',7),('정지원',9),('김동욱',10),('이해리',11),('조재영',22),('윤여창',23),('권능',23)
  ),
  committee_people as (
    select
      c->>'name' as name,
      nullif(regexp_replace(coalesce(c->>'gen',''),'[^0-9]','','g'),'')::int as generation
    from src, jsonb_array_elements(coalesce(src.data->'committee','[]'::jsonb)) c
    union
    select name,generation from fixed_committee_people
  ),
  attendance_base_raw as (
    select name,generation from first_confirmed
    union all
    select name,generation from sponsor_people
    union all
    select name,generation from committee_people
  ),
  attendance_base as (
    select name, max(generation) as generation
    from attendance_base_raw
    where coalesce(name,'')<>''
    group by name
  ),
  all_attendance_raw as (
    select name,generation from attendance_base
    union all
    select name,generation from second_confirmed
  ),
  all_attendance as (
    select name, max(generation) as generation
    from all_attendance_raw
    where coalesce(name,'')<>''
    group by name
  ),
  attendance_by_generation as (
    select generation, count(*)::int as count
    from all_attendance
    where generation is not null
    group by generation
    order by generation
  ),
  related_brands as (
    select distinct
      case
        when s->>'name' like 'CJ HMR One Meal팀 / %' then 'CJ제일제당 HMR One Meal팀'
        else trim(split_part(s->>'name',' / ',1))
      end as brand
    from src, jsonb_array_elements(coalesce(src.data->'sponsors','[]'::jsonb)) s
    where coalesce(s->>'name','') <> ''
      and s->>'name' <> '김동윤(8기)'
      and coalesce(s->>'note','') not like '%브랜드 노출 원하지 않음%'
  ),
  counts as (
    select
      (select count(*)::int from first_confirmed) as first_confirmed_count,
      (select count(*)::int from second_confirmed) as second_confirmed_count,
      (select count(*)::int from attendance_base) as expected_attendance_base,
      (select count(*)::int from all_attendance) as expected_attendance
  )
  select jsonb_build_object(
    'publicInfo', coalesce(src.data->'publicInfo','{}'::jsonb),
    'publicAlumniStats', src.data#>'{formSync,alumniStats}',
    'participantApplicationStats', jsonb_build_object(
      'total', counts.expected_attendance,
      'expectedAttendance', counts.expected_attendance,
      'expectedAttendanceBase', counts.expected_attendance_base,
      'firstConfirmed', counts.first_confirmed_count,
      'secondApplications', counts.second_confirmed_count,
      'attendanceByGeneration', coalesce((
        select jsonb_agg(
          jsonb_build_object('generation', generation, 'count', count)
          order by generation
        )
        from attendance_by_generation
      ), '[]'::jsonb),
      'updatedAt', to_jsonb(src.updated_at)
    ),
    'relatedBrands', coalesce((
      select jsonb_agg(brand order by brand)
      from related_brands
      where coalesce(brand,'') <> ''
    ), '[]'::jsonb),
    'confirmedSponsors', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', sponsor->>'name',
          'support', case sponsor->>'name'
            when 'CJ제일제당' then '행사 사은품·경품'
            when '김나운(9기)' then '케이크'
            when '김동윤(8기)' then '베이커리'
            when '손바울(10기)' then '핑거푸드'
            when '이지훈(16기)' then '와인'
            when '조아름(12기) · 학화호도과자' then '답례품'
            when '최재욱(15기)' then '현수막·배너·포토존'
            else '행사 협찬'
          end
        )
        order by sponsor->>'name'
      )
      from jsonb_array_elements(coalesce(src.data->'sponsors','[]'::jsonb)) sponsor
      where sponsor->>'status' in ('확정','수령완료')
    ), '[]'::jsonb),
    'applicationSchedule', coalesce(src.data->'applicationSchedule','{}'::jsonb),
    'publicPaymentAccount', case when now()>=timestamptz '2026-10-19 00:00:00+09' then '{}'::jsonb else jsonb_build_object(
      'bankName', coalesce(src.data#>>'{eventAccount,bankName}',''),
      'accountNumber', coalesce(src.data#>>'{eventAccount,accountNumber}',''),
      'holder', coalesce(src.data#>>'{eventAccount,holder}',''),
      'participantFee', 80000
    ) end,
    'updatedAt', to_jsonb(src.updated_at)
  )
  from src
  cross join counts;
$function$;
