-- 선후배 질문(게시판 분류) + 동문 실무 자료실.
--
-- 새 표는 모두 anon·authenticated 권한을 주지 않습니다.
-- hanjogo-access 함수(service role)만 읽고 쓰며, 동문 인증·작성자 확인은 함수가 합니다.
-- 목록에는 표시 이름(프로필의 이름 표시 방식 적용)과 기수만 나갑니다. 이메일은 내보내지 않습니다.

-- 1) 프로필: 도와줄 수 있는 분야. 프로필 공개에 동의한 사람만 다른 동문에게 보입니다.
alter table public.hanjogo_profile_overrides
  add column if not exists help_topics text[] not null default '{}';

-- 2) 선후배 질문은 게시판의 한 분류('question')입니다. 답변은 기존 댓글을 씁니다.
--    질문 글에만 분야(topic)와 해결됨 표시(is_resolved)가 붙습니다.
alter table public.hanjogo_board_posts add column if not exists topic text check (topic is null or length(topic) between 1 and 40);
alter table public.hanjogo_board_posts add column if not exists is_resolved boolean not null default false;
alter table public.hanjogo_board_posts drop constraint if exists hanjogo_board_posts_category_check;
alter table public.hanjogo_board_posts add constraint hanjogo_board_posts_category_check
  check (category in ('free', 'jobs', 'collab', 'business', 'notice', 'question'));

-- 3) 실무 자료실. 파일은 비공개 저장소(hanjogo-resources)에 두고, 받을 때마다 함수가 짧은 주소를 만들어 줍니다.
create table if not exists public.hanjogo_resources (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  email text not null check (email = lower(btrim(email))),
  display_name text not null check (length(display_name) between 1 and 40),
  generation int check (generation between 1 and 99),
  title text not null check (length(btrim(title)) between 1 and 100),
  category text not null check (category in ('cost', 'order', 'store', 'career', 'hygiene', 'etc')),
  description text check (length(description) <= 1500),
  file_path text check (length(file_path) <= 300),
  file_name text check (length(file_name) <= 200),
  file_size int check (file_size between 1 and 10485760),
  link_url text check (link_url ~ '^https?://' and length(link_url) <= 500),
  download_count int not null default 0,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (file_path is not null or link_url is not null)
);

create table if not exists public.hanjogo_resource_comments (
  id bigint generated always as identity primary key,
  resource_id bigint not null references public.hanjogo_resources (id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (length(display_name) between 1 and 40),
  generation int check (generation between 1 and 99),
  content text not null check (length(btrim(content)) between 1 and 1000),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.hanjogo_resources enable row level security;
alter table public.hanjogo_resource_comments enable row level security;
revoke all on table public.hanjogo_resources from anon, authenticated;
revoke all on table public.hanjogo_resource_comments from anon, authenticated;

create index if not exists hanjogo_resources_created_idx on public.hanjogo_resources (created_at desc);
create index if not exists hanjogo_resource_comments_r_idx on public.hanjogo_resource_comments (resource_id, created_at);

-- 4) 자료도 즐겨찾기(저장)할 수 있게 합니다.
alter table public.hanjogo_favorites drop constraint if exists hanjogo_favorites_kind_check;
alter table public.hanjogo_favorites add constraint hanjogo_favorites_kind_check
  check (kind in ('place', 'profile', 'resource'));

-- 5) 자료 파일 저장소. 비공개이며 정책을 두지 않아 service role(함수)만 접근합니다. 한 파일 10MB까지.
insert into storage.buckets (id, name, public, file_size_limit)
values ('hanjogo-resources', 'hanjogo-resources', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;
