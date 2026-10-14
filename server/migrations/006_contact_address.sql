-- Where the business is and who the person is there (imported lists from licensing boards, etc.).
alter table contacts add column if not exists title text;
alter table contacts add column if not exists address text;
alter table contacts add column if not exists city text;
alter table contacts add column if not exists county text;
alter table contacts add column if not exists zip text;
create index if not exists contacts_city on contacts (business_id, city) where deleted_at is null;
create index if not exists contacts_county on contacts (business_id, county) where deleted_at is null;
create index if not exists contacts_industry on contacts (business_id, industry) where deleted_at is null;
