-- 생일 축하: 내 정보에서 직접 켠 동문만 대상입니다(처음엔 모두 꺼짐).
-- 생년월일은 여기에 저장하지 않습니다. hanjogo-access 함수가 졸업생 DB에서 월·일만 읽어
-- "오늘 생일인지"만 판단하고, 화면에는 오늘 생일인 사람의 표시 이름·기수만 내려보냅니다.
--
-- 두 표 모두 anon·authenticated 권한이 없고 hanjogo-access 함수만 읽고 씁니다.
create table if not exists public.hanjogo_birthday_optin (
  email text primary key check (email = lower(btrim(email))),
  created_at timestamptz not null default now()
);
alter table public.hanjogo_birthday_optin enable row level security;
revoke all on table public.hanjogo_birthday_optin from anon, authenticated;

-- 축하하기: 한 사람이 같은 동문에게 하루 한 번만 남깁니다.
create table if not exists public.hanjogo_birthday_cheers (
  id bigint generated always as identity primary key,
  recipient_email text not null check (recipient_email = lower(btrim(recipient_email))),
  sender_email text not null check (sender_email = lower(btrim(sender_email))),
  cheer_date date not null,
  created_at timestamptz not null default now(),
  unique (recipient_email, sender_email, cheer_date)
);
alter table public.hanjogo_birthday_cheers enable row level security;
revoke all on table public.hanjogo_birthday_cheers from anon, authenticated;
create index if not exists hanjogo_birthday_cheers_day_idx
  on public.hanjogo_birthday_cheers (cheer_date, recipient_email);

-- 🔔 알림에 '생일 축하' 종류를 더합니다.
alter table public.hanjogo_notifications drop constraint if exists hanjogo_notifications_kind_check;
alter table public.hanjogo_notifications add constraint hanjogo_notifications_kind_check
  check (kind in ('mention', 'answer', 'comment', 'birthday'));
