-- 게시판 글의 "이메일로 연락하기" 버튼: 글마다 글쓴이가 이메일 연락을 받을지 정합니다.
--   true  = 이 글에서 연락받기를 켬 → 인증한 동문에게 글쓴이 이메일로 연락하기 버튼을 보여줍니다.
--   false = 끔 → 보여주지 않습니다.
--   null  = 정하지 않은 예전 글 → 글쓴이가 프로필에서 이메일 연락을 허락했을 때만 보여줍니다.
-- 이메일은 hanjogo-access 함수가 위 조건일 때만 응답에 담습니다. 표 권한은 바꾸지 않습니다.
alter table public.hanjogo_board_posts add column if not exists allow_email_contact boolean;
