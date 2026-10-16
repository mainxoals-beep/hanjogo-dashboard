begin;
-- 행사 사진(2026 모임 탭): 동문 인증한 사람만 보고 올립니다.
--
-- 사진 파일은 비공개 저장소 hanjogo-event-photos 에 두고, 정책을 두지 않아 service role
-- (hanjogo-access 함수)만 접근합니다. 화면에는 함수가 만든 짧게 쓰는 주소만 내려갑니다.
-- 표도 anon·authenticated 권한 없이 함수만 읽고 씁니다. 올린 사람의 이메일은 저장하지 않고,
-- 프로필 표시 방식대로 정한 이름·기수만 적습니다.
-- 휴대폰에서 줄여서 올립니다: 큰 사진(긴 쪽 1600px)과 바둑판용 작은 사진 두 개.

create table if not exists public.hanjogo_event_photos (
  id bigint generated always as identity primary key,
  event_key text not null default '2026-10-18' check (length(event_key) <= 20),
  user_id uuid not null,
  author_name text not null check (length(author_name) between 1 and 40),
  author_generation int check (author_generation between 1 and 99),
  photo_path text not null check (length(photo_path) <= 300),
  thumb_path text not null check (length(thumb_path) <= 300),
  width int check (width between 1 and 10000),
  height int check (height between 1 and 10000),
  caption text check (length(caption) <= 200),
  created_at timestamptz not null default now()
);
alter table public.hanjogo_event_photos enable row level security;
revoke all on table public.hanjogo_event_photos from anon, authenticated;
create index if not exists hanjogo_event_photos_event_idx
  on public.hanjogo_event_photos (event_key, id desc);
create index if not exists hanjogo_event_photos_user_idx
  on public.hanjogo_event_photos (user_id);

create table if not exists public.hanjogo_event_photo_likes (
  photo_id bigint not null references public.hanjogo_event_photos (id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);
alter table public.hanjogo_event_photo_likes enable row level security;
revoke all on table public.hanjogo_event_photo_likes from anon, authenticated;

-- 사진 저장소. 비공개, 한 파일 3MB까지, JPEG·WebP만.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hanjogo-event-photos', 'hanjogo-event-photos', false, 3145728, array['image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/webp'];
commit;
