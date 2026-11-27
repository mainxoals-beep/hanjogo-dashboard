-- 사이트에 바라는 기능을 자유롭게 받는 메모.
-- 로그인한 사용자가 남기고, 읽기는 편집자(관리자)만 합니다. 결과에는 누가 썼는지(이메일·아이디)를 내보내지 않습니다.
create table if not exists public.hanjogo_site_feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  content text not null check (char_length(btrim(content)) between 1 and 1000),
  created_at timestamptz not null default now()
);
alter table public.hanjogo_site_feedback enable row level security;
revoke all on table public.hanjogo_site_feedback from anon, authenticated;

-- 남기기: 로그인한 사람만, 한 사람이 하루 5개까지.
create or replace function public.submit_hanjogo_site_feedback(p_content text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare uid uuid := auth.uid(); body text := btrim(coalesce(p_content, ''));
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if char_length(body) < 1 or char_length(body) > 1000 then raise exception 'invalid_content' using errcode = '22023'; end if;
  if (select count(*) from public.hanjogo_site_feedback where user_id = uid and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many' using errcode = '22023';
  end if;
  insert into public.hanjogo_site_feedback (user_id, content) values (uid, body);
  return true;
end;
$fn$;
revoke all on function public.submit_hanjogo_site_feedback(text) from public, anon;
grant execute on function public.submit_hanjogo_site_feedback(text) to authenticated;

-- 모아보기: 편집자만. 내용과 날짜만 내보냅니다.
create or replace function public.get_hanjogo_site_feedback()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.is_hanjogo_dashboard_editor() then raise exception 'not_editor' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('content', content, 'createdAt', created_at) order by created_at desc)
    from public.hanjogo_site_feedback), '[]'::jsonb);
end;
$fn$;
revoke all on function public.get_hanjogo_site_feedback() from public, anon;
grant execute on function public.get_hanjogo_site_feedback() to authenticated;
