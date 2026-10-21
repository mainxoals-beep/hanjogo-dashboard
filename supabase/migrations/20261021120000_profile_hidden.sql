-- 본인 요청 등으로 공개 프로필 목록에서 숨기는 중복 프로필 규칙.
-- 이름·기수·소속 키워드가 모두 맞는 구글폼 프로필 줄을 hanjogo-access 함수가 목록에서 뺍니다.
-- 같은 사람의 다른 프로필이 남아 있을 때만 숨깁니다. 표는 anon·authenticated 권한이 없고 이메일 등 개인정보는 담지 않습니다.
create table if not exists public.hanjogo_profile_hidden (
  id bigint generated always as identity primary key,
  name text not null check (length(btrim(name)) between 1 and 40),
  generation int check (generation between 1 and 99),
  company_keyword text check (length(company_keyword) <= 60),
  reason text check (length(reason) <= 200),
  created_at timestamptz not null default now()
);
alter table public.hanjogo_profile_hidden enable row level security;
revoke all on table public.hanjogo_profile_hidden from anon, authenticated;

insert into public.hanjogo_profile_hidden (name, generation, company_keyword, reason) values
 ('신정아', 16, '원앤원', '본인 요청: 이전에 등록한 중복 프로필(소속 원앤원) 삭제, 2026-10-21'),
 ('신정아', 16, '원할머니', '본인 요청: 이전에 등록한 중복 프로필(소속 원할머니보쌈) 삭제, 2026-10-21');
