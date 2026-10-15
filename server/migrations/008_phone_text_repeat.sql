-- An owner/admin may make a list that texts people again before the usual waiting period (e.g. a test, or a failed send).
alter table phone_text_batches add column if not exists allow_repeat boolean not null default false;
