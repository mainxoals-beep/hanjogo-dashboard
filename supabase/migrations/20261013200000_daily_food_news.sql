begin;
-- 오늘의 F&B 소식: every morning the database collects headlines (title, source, link only) from
-- Google News RSS for a few industry keywords and keeps 5 a day. No article text or images are stored.
create schema if not exists news_private;
revoke all on schema news_private from public, anon, authenticated;

create table if not exists public.hanjogo_daily_news (
  id bigserial primary key,
  news_date date not null,
  rank smallint not null default 99,
  title text not null check (char_length(title) between 1 and 200),
  url text not null check (url ~ '^https://' and char_length(url) <= 1000),
  source text check (char_length(source) <= 80),
  keyword text check (char_length(keyword) <= 40),
  published_at timestamptz,
  manual boolean not null default false,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (news_date, url)
);
alter table public.hanjogo_daily_news enable row level security;
revoke all on public.hanjogo_daily_news from anon, authenticated;
grant select (id, news_date, rank, title, url, source, keyword, published_at, manual) on public.hanjogo_daily_news to anon, authenticated;
grant insert (news_date, rank, title, url, source, manual), update (hidden) on public.hanjogo_daily_news to authenticated;
grant usage on sequence public.hanjogo_daily_news_id_seq to authenticated;
drop policy if exists "daily news public read" on public.hanjogo_daily_news;
create policy "daily news public read" on public.hanjogo_daily_news for select
  using (not hidden and news_date >= (now() at time zone 'Asia/Seoul')::date - 14);
-- Editors (internal dashboard accounts) may hide an item or add a link by hand.
drop policy if exists "daily news editor read" on public.hanjogo_daily_news;
create policy "daily news editor read" on public.hanjogo_daily_news for select to authenticated
  using (public.is_hanjogo_dashboard_editor());
drop policy if exists "daily news editor hide" on public.hanjogo_daily_news;
create policy "daily news editor hide" on public.hanjogo_daily_news for update to authenticated
  using (public.is_hanjogo_dashboard_editor()) with check (public.is_hanjogo_dashboard_editor());
drop policy if exists "daily news editor add" on public.hanjogo_daily_news;
create policy "daily news editor add" on public.hanjogo_daily_news for insert to authenticated
  with check (public.is_hanjogo_dashboard_editor() and manual);

create table if not exists news_private.requests (
  request_id bigint primary key,
  keyword text not null,
  requested_at timestamptz not null default now()
);

-- Step 1 (07:50 KST): ask pg_net to fetch one RSS feed per keyword.
create or replace function news_private.request_feeds()
returns void language plpgsql security definer set search_path='' as $fn$
declare k text;
begin
  delete from news_private.requests where requested_at < now() - interval '1 day';
  foreach k in array array['외식업','식품업계','프랜차이즈 외식','파인다이닝','미쉐린 레스토랑','제과제빵 베이커리','와인 업계','호텔 레스토랑 셰프','해외 외식 트렌드','K푸드 해외'] loop
    insert into news_private.requests(request_id, keyword)
    values (net.http_get(
      -- Korean keywords must be percent-encoded (UTF-8 bytes), otherwise Google returns 400.
      url := 'https://news.google.com/rss/search?q='||(select string_agg('%'||upper(encode(substring(b from n for 1),'hex')),'' order by n) from (select convert_to(k,'UTF8') b) x, generate_series(1,octet_length(convert_to(k,'UTF8'))) n)||'+when:2d&hl=ko&gl=KR&ceid=KR:ko',
      timeout_milliseconds := 15000), k);
  end loop;
end $fn$;

-- Step 2 (08:00 KST): parse the responses and keep 5 fresh, varied, non-promotional headlines.
create or replace function news_private.collect()
returns integer language plpgsql security definer set search_path='' as $fn$
declare today date := (now() at time zone 'Asia/Seoul')::date; added integer;
begin
  with items as (
    select r.keyword,
      (xpath('/item/title/text()', i))[1]::text as raw_title,
      (xpath('/item/source/text()', i))[1]::text as source,
      (xpath('/item/link/text()', i))[1]::text as url,
      (xpath('/item/pubDate/text()', i))[1]::text as pub
    from news_private.requests r
    join net._http_response h on h.id = r.request_id and h.status_code = 200
    -- pg_net also holds other jobs' responses; only parse our XML feeds (the planner may look at every row).
    cross join lateral unnest(xpath('//item', case when h.status_code = 200 and left(ltrim(h.content), 5) = '<?xml' then h.content::xml end)) as i
  ), cleaned as (
    select keyword, source, url,
      btrim(regexp_replace(raw_title, '\s+-\s+[^-]+$', '')) as title,
      case when pub ~ '^[A-Za-z]{3}, ' then to_timestamp(pub, 'Dy, DD Mon YYYY HH24:MI:SS') else null end as published_at
    from items
  ), fresh as (
    select * from cleaned
    where title is not null and url ~ '^https://' and published_at > now() - interval '36 hours'
      and title !~ '(광고|이벤트|할인|특가|쿠폰|증정|분양|모집\s*공고|\[AD\]|부고|인사\]|\[사설\]|\[칼럼\]|대법원|검찰|국회의원|정치)'
      -- blogs and community posts are not news
      and coalesce(source, '') !~* '(blog|블로그|티스토리|tistory|브런치|카페|youtube|유튜브)'
      -- not a link already shown (or hidden) in the last few days
      and not exists (select 1 from public.hanjogo_daily_news n where n.url = cleaned.url and n.news_date >= today - 3)
  ), dedup as (
    -- the same story from several outlets: keep the earliest one
    select distinct on (left(regexp_replace(title, '[^가-힣A-Za-z0-9]', '', 'g'), 10)) *
    from fresh order by left(regexp_replace(title, '[^가-힣A-Za-z0-9]', '', 'g'), 10), published_at
  ), ranked as (
    -- one per keyword first, newest first, so the 5 items cover different topics
    select *, row_number() over (partition by keyword order by published_at desc) as per_kw from dedup
  ), picked as (
    select * from ranked order by per_kw, published_at desc limit 5
  )
  insert into public.hanjogo_daily_news (news_date, rank, title, url, source, keyword, published_at)
  select today, row_number() over (order by per_kw, published_at desc), left(title, 200), url, left(source, 80), keyword, published_at
  from picked
  where not exists (select 1 from public.hanjogo_daily_news n where n.news_date = today and not n.manual and not n.hidden)
  on conflict (news_date, url) do nothing;
  get diagnostics added = row_count;
  -- Old rows are kept (5 a day is tiny); the public policy only shows the last 14 days.
  return added;
end $fn$;
revoke all on function news_private.request_feeds() from public, anon, authenticated;
revoke all on function news_private.collect() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('hanjogo-news-request', 'hanjogo-news-collect');
select cron.schedule('hanjogo-news-request', '50 22 * * *', $$select news_private.request_feeds()$$);
select cron.schedule('hanjogo-news-collect', '0 23 * * *', $$select news_private.collect()$$);
commit;
