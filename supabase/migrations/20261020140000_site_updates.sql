-- 사이트 새 소식: 업데이트가 있을 때 한 줄로 알립니다.
-- 홈의 "새 소식" 띠와 🔔 알림 목록에 보이고, 읽은 곳까지는 각자 기기에 기억합니다(서버에 개인 기록 없음).
-- 표는 anon·authenticated 권한이 없고, get_hanjogo_site_updates()가 숨기지 않은 최근 10건만 내려줍니다.
create table if not exists public.hanjogo_site_updates (
  id bigint generated always as identity primary key,
  title text not null check (length(btrim(title)) between 1 and 60),
  body text check (length(body) <= 200),
  target text check (target in ('home','event','network','board','meetups','places','fnb')),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.hanjogo_site_updates enable row level security;
revoke all on table public.hanjogo_site_updates from anon, authenticated;

create or replace function public.get_hanjogo_site_updates()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'title', u.title, 'body', coalesce(u.body,''), 'target', u.target, 'createdAt', u.created_at
  ) order by u.id desc), '[]'::jsonb)
  from (select * from public.hanjogo_site_updates where not is_hidden order by id desc limit 10) u;
$function$;
revoke all on function public.get_hanjogo_site_updates() from public;
grant execute on function public.get_hanjogo_site_updates() to anon, authenticated;

insert into public.hanjogo_site_updates (title, body, target, created_at) values
 ('홈 화면이 새로워졌어요', '소개·숫자, 다음 할 일, 바로가기, 최근 동문 소식을 한눈에 볼 수 있어요.', 'home', timestamptz '2026-10-19 09:00+09'),
 ('F&B 소식·채용 탭이 생겼어요', '업계 소식과 마감 전인 채용 공고를 한곳에서 봐요. 채용은 동문 인증 후 볼 수 있어요.', 'fnb', timestamptz '2026-10-19 18:00+09'),
 ('오늘 생일인 동문에게 축하를 보내보세요', '내 정보에서 ''생일 축하 받기''를 켜면 생일 당일 동문 찾기 맨 위에 이름이 보여요.', 'network', timestamptz '2026-10-20 10:00+09'),
 ('둘러보기가 생겼어요', '사이트 기능을 한 장씩 소개해요. 홈 맨 아래 ''둘러보기 다시 보기''에서 언제든 볼 수 있어요.', 'home', now());
