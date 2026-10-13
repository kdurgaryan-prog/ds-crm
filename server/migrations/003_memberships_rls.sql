-- Team membership is business data too: each business sees only its own team.
alter table memberships enable row level security;
alter table memberships force row level security;
create policy tenant_isolation on memberships using (app_sys() or business_id = app_biz()) with check (app_sys() or business_id = app_biz());
