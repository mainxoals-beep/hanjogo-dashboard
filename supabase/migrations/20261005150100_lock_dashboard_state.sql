-- Phase 2: apply ONLY after the index.html login change is live on GitHub Pages
-- and a committee member has confirmed they can sign in and edit.
-- Removes anonymous access to the internal dashboard row.

drop policy if exists "dashboard public read" on public.dashboard_state;
drop policy if exists "dashboard public insert" on public.dashboard_state;
drop policy if exists "dashboard public update" on public.dashboard_state;

revoke all on table public.dashboard_state from anon;
-- authenticated keeps select/insert/update grants; RLS ("dashboard editors *") limits them to editors.

revoke execute on function public.update_hanjogo_dashboard_key(text, jsonb, text) from public, anon;
