-- 자료실을 게시판의 "자료 공유" 분류로 합칩니다.
--
-- 자료 공유 글은 분야(topic: cost/order/store/career/hygiene/etc)와 함께
-- 파일(비공개 저장소 hanjogo-resources) 또는 링크를 가집니다. 다른 분류 글은 첨부가 없습니다.
-- 게시판 표는 계속 anon·authenticated 권한 없이 hanjogo-access 함수만 읽고 씁니다.
-- 예전 자료실 표(hanjogo_resources, hanjogo_resource_comments)는 비어 있고 더 쓰지 않지만,
-- 바로 지우지 않고 새 방식이 잘 돌아가는 걸 확인한 뒤 정리합니다.
alter table public.hanjogo_board_posts
  add column if not exists file_path text check (length(file_path) <= 300),
  add column if not exists file_name text check (length(file_name) <= 200),
  add column if not exists file_size int check (file_size between 1 and 10485760),
  add column if not exists link_url text check (link_url ~ '^https?://' and length(link_url) <= 500),
  add column if not exists download_count int not null default 0;

alter table public.hanjogo_board_posts drop constraint if exists hanjogo_board_posts_category_check;
alter table public.hanjogo_board_posts add constraint hanjogo_board_posts_category_check
  check (category in ('free', 'jobs', 'collab', 'business', 'notice', 'question', 'resource'));
