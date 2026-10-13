begin;
-- 오늘의 F&B 소식 via the Naver News Search API, so links open in Naver's cleaner news viewer
-- (n.news.naver.com) when the outlet is a Naver partner. The API keys live in Supabase Vault as
-- 'naver_client_id' / 'naver_client_secret' (added by the admin in the SQL editor, never committed).
-- Without the keys the job keeps using Google News RSS.
alter table news_private.requests add column if not exists provider text not null default 'google';

create or replace function news_private.encode_query(k text)
returns text language sql immutable set search_path='' as $fn$
  select string_agg('%'||upper(encode(substring(b from n for 1),'hex')),'' order by n)
  from (select convert_to(k,'UTF8') b) x, generate_series(1, octet_length(convert_to(k,'UTF8'))) n
$fn$;

create or replace function news_private.request_feeds()
returns void language plpgsql security definer set search_path='' as $fn$
declare k text; cid text; csec text;
begin
  delete from news_private.requests where requested_at < now() - interval '1 day';
  select decrypted_secret into cid from vault.decrypted_secrets where name = 'naver_client_id';
  select decrypted_secret into csec from vault.decrypted_secrets where name = 'naver_client_secret';
  foreach k in array array['외식업','식품업계','프랜차이즈 외식','파인다이닝','미쉐린 레스토랑','제과제빵 베이커리','와인 업계','호텔 레스토랑 셰프','해외 외식 트렌드','K푸드 해외'] loop
    if cid is not null and csec is not null then
      insert into news_private.requests(request_id, keyword, provider)
      values (net.http_get(
        url := 'https://openapi.naver.com/v1/search/news.json?query='||news_private.encode_query(k)||'&display=30&sort=date',
        headers := jsonb_build_object('X-Naver-Client-Id', cid, 'X-Naver-Client-Secret', csec),
        timeout_milliseconds := 15000), k, 'naver');
    else
      insert into news_private.requests(request_id, keyword, provider)
      values (net.http_get(
        url := 'https://news.google.com/rss/search?q='||news_private.encode_query(k)||'+when:2d&hl=ko&gl=KR&ceid=KR:ko',
        timeout_milliseconds := 15000), k, 'google');
    end if;
  end loop;
end $fn$;

-- Short outlet names for common domains (Naver's API gives only the article address).
create or replace function news_private.outlet_name(url text)
returns text language sql immutable set search_path='' as $fn$
  select case
    when h ~ '(^|\.)yna\.co\.kr$' then '연합뉴스' when h ~ '(^|\.)mk\.co\.kr$' then '매일경제'
    when h ~ '(^|\.)hankyung\.com$' then '한국경제' when h ~ '(^|\.)chosun\.com$' then '조선일보'
    when h ~ '(^|\.)joongang\.co\.kr$' then '중앙일보' when h ~ '(^|\.)donga\.com$' then '동아일보'
    when h ~ '(^|\.)hani\.co\.kr$' then '한겨레' when h ~ '(^|\.)khan\.co\.kr$' then '경향신문'
    when h ~ '(^|\.)mt\.co\.kr$' then '머니투데이' when h ~ '(^|\.)edaily\.co\.kr$' then '이데일리'
    when h ~ '(^|\.)news1\.kr$' then '뉴스1' when h ~ '(^|\.)newsis\.com$' then '뉴시스'
    when h ~ '(^|\.)sedaily\.com$' then '서울경제' when h ~ '(^|\.)asiae\.co\.kr$' then '아시아경제'
    when h ~ '(^|\.)heraldcorp\.com$' then '헤럴드경제' when h ~ '(^|\.)fnnews\.com$' then '파이낸셜뉴스'
    when h ~ '(^|\.)newspim\.com$' then '뉴스핌' when h ~ '(^|\.)hankookilbo\.com$' then '한국일보'
    when h ~ '(^|\.)seoul\.co\.kr$' then '서울신문' when h ~ '(^|\.)kmib\.co\.kr$' then '국민일보'
    when h ~ '(^|\.)segye\.com$' then '세계일보' when h ~ '(^|\.)munhwa\.com$' then '문화일보'
    when h ~ '(^|\.)etoday\.co\.kr$' then '이투데이' when h ~ '(^|\.)ajunews\.com$' then '아주경제'
    when h ~ '(^|\.)foodbank\.co\.kr$' then '식품외식경제' when h ~ '(^|\.)foodtoday\.or\.kr$' then '푸드투데이'
    when h ~ '(^|\.)thinkfood\.co\.kr$' then '식품음료신문' when h ~ '(^|\.)nongmin\.com$' then '농민신문'
    else h end
  from (select regexp_replace(substring(coalesce(url,'') from '^https?://([^/]+)'), '^(www|m|news)\.', '') h) x
$fn$;

create or replace function news_private.collect()
returns integer language plpgsql security definer set search_path='' as $fn$
declare today date := (now() at time zone 'Asia/Seoul')::date; added integer;
begin
  with google as (
    select r.keyword,
      (xpath('/item/title/text()', i))[1]::text as raw_title,
      (xpath('/item/source/text()', i))[1]::text as source,
      (xpath('/item/link/text()', i))[1]::text as url,
      case when (xpath('/item/pubDate/text()', i))[1]::text ~ '^[A-Za-z]{3}, ' then to_timestamp((xpath('/item/pubDate/text()', i))[1]::text, 'Dy, DD Mon YYYY HH24:MI:SS') end as published_at,
      false as naver_view
    from news_private.requests r
    join net._http_response h on h.id = r.request_id and h.status_code = 200 and r.provider = 'google'
    -- pg_net also holds other jobs' responses; only parse our XML feeds (the planner may look at every row).
    cross join lateral unnest(xpath('//item', case when h.status_code = 200 and left(ltrim(h.content), 5) = '<?xml' then h.content::xml end)) as i
  ), naver as (
    select r.keyword,
      e->>'title' as raw_title,
      news_private.outlet_name(e->>'originallink') as source,
      case when e->>'link' like 'https://n.news.naver.com/%' then e->>'link' else coalesce(nullif(e->>'originallink',''), e->>'link') end as url,
      case when e->>'pubDate' ~ '^[A-Za-z]{3}, ' then (to_timestamp(left(e->>'pubDate', 25), 'Dy, DD Mon YYYY HH24:MI:SS')::timestamp at time zone 'Asia/Seoul') end as published_at,
      e->>'link' like 'https://n.news.naver.com/%' as naver_view
    from news_private.requests r
    join net._http_response h on h.id = r.request_id and h.status_code = 200 and r.provider = 'naver'
    cross join lateral jsonb_array_elements(case when h.status_code = 200 and left(ltrim(h.content), 1) = '{' then h.content::jsonb -> 'items' else '[]'::jsonb end) as e
  ), items as (
    select * from google union all select * from naver
  ), cleaned as (
    select keyword, source, url, published_at, naver_view,
      btrim(regexp_replace(replace(replace(replace(replace(replace(replace(
        regexp_replace(raw_title, '<[^>]+>', '', 'g'),
        '&quot;', '"'), '&#39;', ''''), '&apos;', ''''), '&lt;', '<'), '&gt;', '>'), '&amp;', '&'),
        '\s+-\s+[^-]+$', '')) as title
    from items
  ), fresh as (
    select * from cleaned
    where title is not null and title <> '' and url ~ '^https://' and published_at > now() - interval '36 hours'
      and title !~ '(광고|이벤트|할인|특가|쿠폰|증정|분양|모집\s*공고|\[AD\]|부고|인사\]|\[사설\]|\[칼럼\]|대법원|검찰|국회의원|정치)'
      -- blogs and community posts are not news
      and coalesce(source, '') !~* '(blog|블로그|티스토리|tistory|브런치|카페|youtube|유튜브)'
      -- not a link already shown (or hidden) in the last few days
      and not exists (select 1 from public.hanjogo_daily_news n where n.url = cleaned.url and n.news_date >= today - 3)
  ), dedup as (
    -- the same story from several outlets: keep one, preferring a Naver-viewer link
    select distinct on (left(regexp_replace(title, '[^가-힣A-Za-z0-9]', '', 'g'), 10)) *
    from fresh order by left(regexp_replace(title, '[^가-힣A-Za-z0-9]', '', 'g'), 10), naver_view desc, published_at
  ), ranked as (
    select *, row_number() over (partition by keyword order by naver_view desc, published_at desc) as per_kw from dedup
  ), picked as (
    select * from ranked order by per_kw, naver_view desc, published_at desc limit 5
  )
  insert into public.hanjogo_daily_news (news_date, rank, title, url, source, keyword, published_at)
  select today, row_number() over (order by per_kw, naver_view desc, published_at desc), left(title, 200), url, left(source, 80), keyword, published_at
  from picked
  where not exists (select 1 from public.hanjogo_daily_news n where n.news_date = today and not n.manual and not n.hidden)
  on conflict (news_date, url) do nothing;
  get diagnostics added = row_count;
  -- Old rows are kept (5 a day is tiny); the public policy only shows the last 14 days.
  return added;
end $fn$;
revoke all on function news_private.encode_query(text) from public, anon, authenticated;
revoke all on function news_private.outlet_name(text) from public, anon, authenticated;
revoke all on function news_private.request_feeds() from public, anon, authenticated;
revoke all on function news_private.collect() from public, anon, authenticated;
commit;
