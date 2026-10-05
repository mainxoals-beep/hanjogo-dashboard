-- Phase 1 of locking down the internal dashboard (additive, safe to apply before the frontend change).
-- Adds a server-side editor allowlist and editor-only policies on dashboard_state.
-- The old anon policies stay in place until phase 2 (20261005150100_lock_dashboard_state.sql).

create table if not exists public.hanjogo_dashboard_editors (
  email text primary key check (email = lower(btrim(email)) and email like '%@%'),
  label text not null default '',
  created_at timestamptz not null default now()
);
alter table public.hanjogo_dashboard_editors enable row level security;
revoke all on table public.hanjogo_dashboard_editors from anon, authenticated;

insert into public.hanjogo_dashboard_editors (email, label) values
  ('mainxoals@gmail.com', '관리자'),
  ('mainxoals+hanjogo-committee@gmail.com', '준비위원 공용 계정')
on conflict (email) do nothing;

-- True when the signed-in user's email is in the allowlist.
create or replace function public.is_hanjogo_dashboard_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.hanjogo_dashboard_editors e
    where e.email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );
$$;
revoke all on function public.is_hanjogo_dashboard_editor() from public, anon;
grant execute on function public.is_hanjogo_dashboard_editor() to authenticated;

-- Editor-only access to the internal dashboard row.
drop policy if exists "dashboard editors read" on public.dashboard_state;
drop policy if exists "dashboard editors insert" on public.dashboard_state;
drop policy if exists "dashboard editors update" on public.dashboard_state;
create policy "dashboard editors read" on public.dashboard_state
  for select to authenticated using ((select public.is_hanjogo_dashboard_editor()));
create policy "dashboard editors insert" on public.dashboard_state
  for insert to authenticated with check ((select public.is_hanjogo_dashboard_editor()) and id = 'main');
create policy "dashboard editors update" on public.dashboard_state
  for update to authenticated
  using ((select public.is_hanjogo_dashboard_editor()))
  with check ((select public.is_hanjogo_dashboard_editor()) and id = 'main');

-- Public page functions return only safe projections. Run them as the owner so they keep
-- working after anon loses direct access to dashboard_state in phase 2.
alter function public.get_hanjogo_public_dashboard() security definer;
alter function public.get_hanjogo_story_raffle() security definer;
revoke all on function public.get_hanjogo_public_dashboard() from public;
revoke all on function public.get_hanjogo_story_raffle() from public;
grant execute on function public.get_hanjogo_public_dashboard() to anon, authenticated;
grant execute on function public.get_hanjogo_story_raffle() to anon, authenticated;
