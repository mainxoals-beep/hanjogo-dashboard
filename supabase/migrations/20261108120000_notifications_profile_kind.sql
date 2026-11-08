-- 🔔 알림에 '프로필 안내' 종류를 더합니다. (공개 프로필이 없는 동문에게 한 번 보내는 안내)
alter table public.hanjogo_notifications drop constraint if exists hanjogo_notifications_kind_check;
alter table public.hanjogo_notifications add constraint hanjogo_notifications_kind_check
  check (kind in ('mention', 'answer', 'comment', 'birthday', 'profile'));
