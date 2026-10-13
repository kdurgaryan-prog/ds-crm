-- Deactivating someone applies to one business only, not to their whole account.
alter table memberships add column if not exists active boolean not null default true;
