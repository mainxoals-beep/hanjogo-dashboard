-- 공개 사이트 "내 정보" 기능 1단계.
-- 1) 동문이 사이트 안에서 직접 고친 프로필을 저장할 표를 만듭니다.
-- 2) 업장 표의 과도한 권한을 정리하고, 담당자 이메일을 공개 조회에서 가립니다.
-- 기존 화면 동작을 깨지 않는 범위의 변경이며, 공개 읽기 항목은 그대로 유지됩니다.

-- ---------------------------------------------------------------------------
-- 1. 프로필 덮어쓰기 표
-- ---------------------------------------------------------------------------
-- 프로필 원본은 구글 폼 시트(CSV)입니다. 동문이 사이트에서 고치면 이 표에 저장하고,
-- 서버 함수가 CSV 위에 덮어씌워 보여줍니다. 저장된 행이 있으면 그 내용이 우선입니다.
-- anon/authenticated 에게 권한을 주지 않습니다. 서버 함수(service role)만 읽고 씁니다.
create table if not exists public.hanjogo_profile_overrides (
  email text primary key check (email = lower(btrim(email)) and email like '%@%'),
  name text not null default '',
  generation integer check (generation is null or generation between 1 and 99),
  -- full: 실명 전체 공개, masked: 김○민, hidden: 이름 비공개
  display_mode text not null default 'masked' check (display_mode in ('full','masked','hidden')),
  -- 사이트에 공개할 항목. 서버 함수가 아는 값만 저장합니다.
  public_fields text[] not null default '{}',
  company text not null default '',
  work text not null default '',
  activity text not null default '',
  region text not null default '',
  instagram text not null default '',
  bio text not null default '',
  connect text not null default '',
  allow_email_contact boolean not null default false,
  attendee_visible boolean not null default true,
  -- 공개 동의. false 면 공개 목록에 나오지 않습니다.
  consent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.hanjogo_profile_overrides enable row level security;
revoke all on table public.hanjogo_profile_overrides from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. 업장 표 권한 정리
-- ---------------------------------------------------------------------------
-- TRUNCATE 는 RLS 가 막아주지 못합니다. anon 에게 주어져 있어 먼저 회수합니다.
-- DELETE/INSERT 는 정책이 없어 지금도 막혀 있지만, 권한 자체를 남기지 않습니다.
revoke all on table public.hanjogo_alumni_places from anon, authenticated;
revoke all on table public.hanjogo_alumni_place_submissions from anon, authenticated;
revoke all on table public.hanjogo_alumni_place_claims from anon, authenticated;

-- 지도 화면은 "담당자가 연결돼 있는지"만 알면 됩니다. 이메일 자체는 알 필요가 없습니다.
alter table public.hanjogo_alumni_places
  add column if not exists owner_linked boolean
  generated always as (coalesce(btrim(owner_email), '') <> '') stored;

-- 공개 지도가 읽는 항목만 다시 허용합니다. owner_email 은 제외합니다.
-- (지금까지는 select * 로 담당자 이메일까지 외부에 나갔습니다.)
grant select (
  id, name, owner_name, owner_generation, category, region, address,
  instagram_url, website_url, booking_url, description,
  is_address_verified, is_published, updated_at, owner_linked
) on table public.hanjogo_alumni_places to anon, authenticated;

-- 담당자 본인 수정("alumni places owner update" 정책)이 계속 동작하도록 합니다.
grant update (
  name, category, region, address, instagram_url, website_url,
  booking_url, description, is_address_verified, updated_at
) on table public.hanjogo_alumni_places to authenticated;

-- 등록 신청과 운영자 인증 요청은 로그인한 동문만 넣고, 본인 것만 봅니다(기존 정책 유지).
-- (id 는 identity 컬럼이라 시퀀스 권한은 따로 필요하지 않습니다.)
grant select, insert on table public.hanjogo_alumni_place_submissions to authenticated;
grant select, insert on table public.hanjogo_alumni_place_claims to authenticated;
