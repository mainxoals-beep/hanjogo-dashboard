-- 모임 결산·만족도 조사: 모임에 참가한 사람에게만 상세를 보여주기 위한 밑작업입니다.
-- 세 표 모두 anon·authenticated 권한이 없고 hanjogo-access 함수(서비스 키)만 읽고 씁니다.
-- 참가자 이메일은 이 파일에 넣지 않습니다. 관리자가 함수의 명단 맞추기 기능으로 채웁니다.

-- 모임 한 건의 안내: 간략 요약(누구나) / 상세 결산(참가자만) / 설문 문항
create table if not exists public.hanjogo_event_info (
  event_key text primary key check (event_key ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  title text not null check (char_length(title) between 1 and 80),
  event_date date,
  published boolean not null default false,
  public_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(public_summary) = 'object' and pg_column_size(public_summary) < 8192),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) < 65536),
  survey_open boolean not null default false,
  survey_questions jsonb not null default '[]'::jsonb check (jsonb_typeof(survey_questions) = 'array' and pg_column_size(survey_questions) < 16384),
  updated_at timestamptz not null default now()
);
alter table public.hanjogo_event_info enable row level security;
revoke all on table public.hanjogo_event_info from anon, authenticated;

-- 참가자 명단(이메일 기준). 로그인한 이메일이 여기 있으면 참가자로 봅니다.
create table if not exists public.hanjogo_event_participants (
  event_key text not null references public.hanjogo_event_info (event_key) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  name text,
  generation int check (generation between 1 and 99),
  source text not null default 'auto' check (source in ('auto', 'manual')),
  created_at timestamptz not null default now(),
  primary key (event_key, email)
);
alter table public.hanjogo_event_participants enable row level security;
revoke all on table public.hanjogo_event_participants from anon, authenticated;

-- 그 모임의 최종 참가자 명단(이름·기수만). 이메일 맞추기 기능이 이 명단을 동문 DB와 맞춰 위 참가자 표를 채웁니다.
-- 명단 내용은 이 파일에 넣지 않고 관리자가 따로 채웁니다.
create table if not exists public.hanjogo_event_roster (
  event_key text not null references public.hanjogo_event_info (event_key) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  generation int not null check (generation between 1 and 99),
  primary key (event_key, name, generation)
);
alter table public.hanjogo_event_roster enable row level security;
revoke all on table public.hanjogo_event_roster from anon, authenticated;

-- 만족도 응답: 한 사람이 한 번(다시 보내면 수정). 결과는 평균·개수로만 내보내고 이메일은 내보내지 않습니다.
create table if not exists public.hanjogo_event_survey_responses (
  event_key text not null references public.hanjogo_event_info (event_key) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  generation int check (generation between 1 and 99), -- 참가자 명단의 기수. 기수별 평균(3명 이상일 때만)에만 쓰고 밖으로 내보내지 않습니다.
  answers jsonb not null check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) < 8192),
  updated_at timestamptz not null default now(),
  primary key (event_key, email)
);
alter table public.hanjogo_event_survey_responses enable row level security;
revoke all on table public.hanjogo_event_survey_responses from anon, authenticated;

-- 참가자가 아닌 사람(로그인 전 포함)에게 보여줄 간략 정보. 공개로 정한 모임만, 응답이 5건 이상일 때만 평균을 냅니다.
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
  end if;
  return jsonb_build_object(
    'title', ev.title,
    'eventDate', ev.event_date,
    'summary', ev.public_summary,
    'responseCount', case when n >= 5 then n end,
    'satisfaction', avg_score
  );
end;
$$;
revoke all on function public.get_hanjogo_event_brief(text) from public;
grant execute on function public.get_hanjogo_event_brief(text) to anon, authenticated;
