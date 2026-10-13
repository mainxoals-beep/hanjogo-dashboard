begin;
-- Michelin / Blue Ribbon marks on alumni places. Set by the admin only:
-- owners keep UPDATE on their own columns, and these columns are not granted to them.
alter table public.hanjogo_alumni_places
  add column if not exists michelin text check (michelin in ('3star','2star','1star','bib','selected')),
  add column if not exists michelin_year smallint check (michelin_year between 2000 and 2100),
  add column if not exists blue_ribbon smallint check (blue_ribbon between 1 and 3),
  add column if not exists blue_ribbon_year smallint check (blue_ribbon_year between 2000 and 2100);
grant select (michelin, michelin_year, blue_ribbon, blue_ribbon_year) on public.hanjogo_alumni_places to anon, authenticated;
commit;
