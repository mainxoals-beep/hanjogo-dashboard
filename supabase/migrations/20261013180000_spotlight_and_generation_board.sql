begin;
-- 오늘의 동문: people who asked not to be featured. Read/written only by the edge function (service role).
create table if not exists public.hanjogo_spotlight_optout (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  created_at timestamptz not null default now()
);
alter table public.hanjogo_spotlight_optout enable row level security;
revoke all on public.hanjogo_spotlight_optout from anon, authenticated;

-- 우리 기수 게시판: a post in category "generation" is visible only to that 기수 (checked in the edge function).
alter table public.hanjogo_board_posts add column if not exists target_generation smallint;
alter table public.hanjogo_board_posts drop constraint if exists hanjogo_board_posts_category_check;
alter table public.hanjogo_board_posts add constraint hanjogo_board_posts_category_check
  check (category = any (array['free','jobs','collab','business','notice','question','resource','generation']));
alter table public.hanjogo_board_posts drop constraint if exists hanjogo_board_posts_target_generation_check;
alter table public.hanjogo_board_posts add constraint hanjogo_board_posts_target_generation_check
  check ((category = 'generation') = (target_generation is not null) and (target_generation is null or target_generation between 1 and 99));
commit;
