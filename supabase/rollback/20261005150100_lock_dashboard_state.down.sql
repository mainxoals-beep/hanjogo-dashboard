-- Emergency rollback for phase 2: restores the previous (public) access to dashboard_state.
-- Use only if committee members cannot use the dashboard and there is no time to debug.
create policy "dashboard public read" on public.dashboard_state
  for select to anon, authenticated using (id = 'main');
create policy "dashboard public insert" on public.dashboard_state
  for insert to anon, authenticated with check (id = 'main');
create policy "dashboard public update" on public.dashboard_state
  for update to anon, authenticated using (id = 'main') with check (id = 'main');
grant select, insert, update on table public.dashboard_state to anon, authenticated;
grant execute on function public.update_hanjogo_dashboard_key(text, jsonb, text) to anon, authenticated;
