-- F&B 소식 "숨기기"가 안 되던 문제 수정.
-- 숨긴 글은 읽기 정책에서 안 보이기 때문에, 바로 update 하면 "고친 행이 정책을 어긴다"며 막힙니다.
-- 편집자인지 확인한 뒤 숨김만 바꾸는 함수를 두고, 화면은 이 함수를 부릅니다.
create or replace function public.hide_hanjogo_daily_news(p_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.is_hanjogo_dashboard_editor() then
    raise exception 'not_editor' using errcode = '42501';
  end if;
  update public.hanjogo_daily_news set hidden = true where id = p_id;
  return found;
end;
$fn$;
revoke all on function public.hide_hanjogo_daily_news(bigint) from public, anon;
grant execute on function public.hide_hanjogo_daily_news(bigint) to authenticated;
