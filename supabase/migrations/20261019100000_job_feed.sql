begin;
-- 오늘의 F&B 채용: 게시판 위에 보이는 큐레이션 목록.
--
-- 공고 원문은 복사하지 않고 제목·회사·지역·경력·마감일과 출처 링크만 담습니다.
-- 올리기 전에 원문 페이지를 직접 열어 마감일과 지원 가능 여부를 확인합니다.
-- 글은 서버가 아래 조건으로 걸러서 내보냅니다(화면에서 숨기는 방식이 아닙니다).
--   - 숨김 처리되지 않았고
--   - 마감일이 오늘(한국 시간) 이후이거나 '상시채용'이며
--   - 최근 5일 안에 다시 확인된 글
-- 표는 클라이언트 권한 없이 두고, 읽기는 get_hanjogo_job_feed() 함수만 합니다.
-- 공고 데이터(행)는 이 파일에 넣지 않습니다.

create table if not exists public.hanjogo_job_feed (
  id bigint generated always as identity primary key,
  title text not null check (length(btrim(title)) between 1 and 120),
  company text not null check (length(btrim(company)) between 1 and 60),
  location text check (length(location) <= 40),
  role_group text not null check (role_group in ('chef','rnd','bakery','cafe','ops','hotel','md','marketing','etc')),
  career text not null check (length(btrim(career)) between 1 and 40),
  employment text check (length(employment) <= 20),
  summary text check (length(summary) <= 200),
  closes_on date,
  always_open boolean not null default false,
  source_name text not null check (length(btrim(source_name)) between 1 and 20),
  source_url text not null check (source_url ~ '^https://' and length(source_url) <= 500),
  posted_on date not null default ((now() at time zone 'Asia/Seoul')::date),
  verified_at timestamptz not null default now(),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  check (always_open or closes_on is not null)
);
alter table public.hanjogo_job_feed enable row level security;
revoke all on table public.hanjogo_job_feed from anon, authenticated;
create unique index if not exists hanjogo_job_feed_url_idx on public.hanjogo_job_feed (source_url);
create index if not exists hanjogo_job_feed_posted_idx on public.hanjogo_job_feed (posted_on desc, closes_on);

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
    limit 15
  ) j
$fn$;
revoke all on function public.get_hanjogo_job_feed() from public;
grant execute on function public.get_hanjogo_job_feed() to anon, authenticated;
commit;
