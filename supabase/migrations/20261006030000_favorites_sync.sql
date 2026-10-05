-- 즐겨찾기(관심 동문 · 관심 업장)를 계정에 저장해 기기 간에 따라다니게 합니다.
-- 지금까지는 브라우저에만 저장돼서, 휴대폰에서 누른 별이 컴퓨터에는 보이지 않았습니다.
--
-- 이 표에는 anon·authenticated 권한을 주지 않습니다.
-- hanjogo-access 함수(service role)만 읽고 쓰며, 함수가 본인 이메일 것만 다룹니다.
-- 담는 값은 동문 프로필 id(이메일 해시)와 업장 번호뿐이라 개인정보가 들어가지 않습니다.
create table if not exists public.hanjogo_favorites (
  email text not null check (email = lower(btrim(email)) and email like '%@%'),
  -- place: 동문 업장(hanjogo_alumni_places.id), profile: 공개 동문 프로필(profileId)
  kind text not null check (kind in ('place', 'profile')),
  ref_id text not null check (length(ref_id) between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (email, kind, ref_id)
);
alter table public.hanjogo_favorites enable row level security;
revoke all on table public.hanjogo_favorites from anon, authenticated;

-- 목록을 불러올 때 쓰는 조회입니다.
create index if not exists hanjogo_favorites_email_kind_idx
  on public.hanjogo_favorites (email, kind);
