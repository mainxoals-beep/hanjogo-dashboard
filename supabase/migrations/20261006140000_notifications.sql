-- 사이트 안 알림(🔔). @태그됐을 때, 내 글에 답변·댓글이 달렸을 때 생깁니다.
--
-- anon·authenticated 권한을 주지 않습니다. hanjogo-access 함수만 읽고 쓰며,
-- 항상 로그인한 본인(recipient_email) 것만 보여줍니다.
-- 담는 값은 글 번호와 제목, 보낸 사람의 표시 이름·기수뿐입니다(이메일은 받는 사람 것만, 조회 조건으로만 씁니다).
create table if not exists public.hanjogo_notifications (
  id bigint generated always as identity primary key,
  recipient_email text not null check (recipient_email = lower(btrim(recipient_email))),
  kind text not null check (kind in ('mention', 'answer', 'comment')),
  post_id bigint references public.hanjogo_board_posts (id) on delete cascade,
  title text check (length(title) <= 120),
  actor_name text check (length(actor_name) <= 40),
  actor_generation int check (actor_generation between 1 and 99),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
alter table public.hanjogo_notifications enable row level security;
revoke all on table public.hanjogo_notifications from anon, authenticated;
create index if not exists hanjogo_notifications_recipient_idx
  on public.hanjogo_notifications (recipient_email, created_at desc);
