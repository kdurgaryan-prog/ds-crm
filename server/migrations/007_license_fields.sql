-- Licensing-board columns (e.g. CSLB): license number, business type, industry sub-type, other people on the license.
alter table contacts add column if not exists license_no text;
alter table contacts add column if not exists business_type text;
alter table contacts add column if not exists industry_type text;
alter table contacts add column if not exists other_personnel text;
create index if not exists contacts_industry_type on contacts (business_id, industry_type) where deleted_at is null;
create index if not exists contacts_license on contacts (business_id, license_no) where license_no is not null;
