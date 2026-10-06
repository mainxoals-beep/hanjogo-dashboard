-- 동문 업장 지도에서 새로 등록된 업장을 NEW 로 먼저 보여주기 위해 등록 시각을 둡니다.
--
-- 지금 있는 업장은 "새 업장"이 아니므로 예전 날짜로 채우고, 이후 들어오는 업장만 now() 가 됩니다.
-- 공개 지도가 읽을 수 있게 이 컬럼만 select 권한을 추가합니다(owner_email 은 계속 제외).
alter table public.hanjogo_alumni_places
  add column if not exists created_at timestamptz;
update public.hanjogo_alumni_places
  set created_at = timestamptz '2026-01-01 00:00:00+09'
  where created_at is null;
alter table public.hanjogo_alumni_places
  alter column created_at set default now(),
  alter column created_at set not null;
grant select (created_at) on table public.hanjogo_alumni_places to anon, authenticated;
