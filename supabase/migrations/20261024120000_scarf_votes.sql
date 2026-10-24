-- 기수별 조리복 스카프 색 설문: 동문이 아는 기수의 색을 한 번씩 알려줍니다.
-- 한 사람이 같은 기수에는 하나의 답만 남기고(다시 보내면 덮어씀), 여러 기수에 답할 수 있습니다.
-- 이 표는 anon·authenticated 권한이 없고 hanjogo-access 함수만 읽고 씁니다.
create table if not exists public.hanjogo_scarf_votes (
  email text not null check (email = lower(btrim(email))),
  generation int not null check (generation between 1 and 99),
  color text not null check (color in
    ('red','orange','yellow','lime','green','sky','blue','navy','purple','pink','white','black','brown','gray','other')),
  other_text text check (other_text is null or char_length(other_text) <= 12),
  updated_at timestamptz not null default now(),
  primary key (email, generation)
);
alter table public.hanjogo_scarf_votes enable row level security;
revoke all on table public.hanjogo_scarf_votes from anon, authenticated;
create index if not exists hanjogo_scarf_votes_generation_idx
  on public.hanjogo_scarf_votes (generation, color);
