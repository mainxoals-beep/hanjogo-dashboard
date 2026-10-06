-- 동문 번개·소모임. 누구나(동문 인증한 사람) 모임을 열고, 참석 버튼으로 신청합니다.
--
-- 세 표 모두 anon·authenticated 권한을 주지 않습니다.
-- hanjogo-access 함수(service role)만 읽고 쓰며, 동문 인증·주최자 확인은 함수가 합니다.
-- 참석자 이메일은 주최자에게만 함수가 내려줍니다(전체 연락용). 목록에는 표시 이름만 나갑니다.

create table if not exists public.hanjogo_meetups (
  id bigint generated always as identity primary key,
  host_user_id uuid not null,
  host_email text not null check (host_email = lower(btrim(host_email))),
  -- 프로필의 이름 표시 방식(실명/가운데 ○/비공개)을 적용한 이름입니다.
  host_display_name text not null check (length(host_display_name) between 1 and 40),
  host_generation int check (host_generation between 1 and 99),
  title text not null check (length(btrim(title)) between 1 and 80),
  category text not null check (category in ('food', 'tour', 'hobby', 'work', 'etc')),
  starts_at timestamptz not null,
  region text check (length(region) <= 40),
  place text check (length(place) <= 120),
  capacity int check (capacity between 2 and 200),
  description text check (length(description) <= 1500),
  status text not null default 'open' check (status in ('open', 'cancelled')),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hanjogo_meetup_attendees (
  meetup_id bigint not null references public.hanjogo_meetups (id) on delete cascade,
  user_id uuid not null,
  email text not null check (email = lower(btrim(email))),
  display_name text not null check (length(display_name) between 1 and 40),
  generation int check (generation between 1 and 99),
  created_at timestamptz not null default now(),
  primary key (meetup_id, user_id)
);

create table if not exists public.hanjogo_meetup_comments (
  id bigint generated always as identity primary key,
  meetup_id bigint not null references public.hanjogo_meetups (id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (length(display_name) between 1 and 40),
  generation int check (generation between 1 and 99),
  content text not null check (length(btrim(content)) between 1 and 500),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.hanjogo_meetups enable row level security;
alter table public.hanjogo_meetup_attendees enable row level security;
alter table public.hanjogo_meetup_comments enable row level security;
revoke all on table public.hanjogo_meetups from anon, authenticated;
revoke all on table public.hanjogo_meetup_attendees from anon, authenticated;
revoke all on table public.hanjogo_meetup_comments from anon, authenticated;

create index if not exists hanjogo_meetups_starts_at_idx on public.hanjogo_meetups (starts_at);
create index if not exists hanjogo_meetup_comments_meetup_idx on public.hanjogo_meetup_comments (meetup_id, created_at);

-- 참석 신청. 두 사람이 동시에 마지막 자리를 누르는 경우에도 정원을 넘지 않도록
-- 모임 행을 잠근 뒤 인원을 셉니다. 함수만 호출할 수 있습니다.
create or replace function public.hanjogo_meetup_join(
  p_meetup_id bigint, p_user_id uuid, p_email text, p_display_name text, p_generation int
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.hanjogo_meetups%rowtype;
  taken int;
begin
  select * into m from public.hanjogo_meetups where id = p_meetup_id for update;
  if not found or m.is_hidden then return 'not_found'; end if;
  if m.status <> 'open' then return 'cancelled'; end if;
  if m.starts_at < now() then return 'past'; end if;
  if exists (select 1 from public.hanjogo_meetup_attendees where meetup_id = p_meetup_id and user_id = p_user_id) then
    return 'ok';
  end if;
  select count(*) into taken from public.hanjogo_meetup_attendees where meetup_id = p_meetup_id;
  if m.capacity is not null and taken >= m.capacity then return 'full'; end if;
  insert into public.hanjogo_meetup_attendees (meetup_id, user_id, email, display_name, generation)
  values (p_meetup_id, p_user_id, lower(btrim(p_email)), p_display_name, p_generation);
  return 'ok';
end;
$$;
revoke all on function public.hanjogo_meetup_join(bigint, uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.hanjogo_meetup_join(bigint, uuid, text, text, int) to service_role;
