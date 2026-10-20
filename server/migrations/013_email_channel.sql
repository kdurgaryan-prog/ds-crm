-- Email channel: send from the business mailbox, replies pulled in by IMAP, one-click unsubscribe.
alter table channel_accounts drop constraint if exists channel_accounts_channel_check;
alter table channel_accounts add constraint channel_accounts_channel_check
  check (channel in ('sms','voice','whatsapp','messenger','instagram','webchat','website_forms','ai','shopify','email'));
alter table campaigns drop constraint if exists campaigns_kind_check;
alter table campaigns add constraint campaigns_kind_check
  check (kind in ('social_post','ad_copy','sms_blast','whatsapp_blast','call_campaign','image_prompt','video_script','content_calendar','email_blast'));
alter table contacts add column if not exists email_opted_out_at timestamptz;
alter table messages add column if not exists subject text;
alter table messages add column if not exists in_reply_to text;      -- Message-ID this email answers (threading)
-- IMAP cursor per business: the last mailbox UID already imported
create table if not exists email_sync (
  business_id uuid primary key references businesses(id) on delete cascade,
  last_uid bigint not null default 0,
  uidvalidity bigint,
  last_polled_at timestamptz,
  last_error text
);
alter table email_sync enable row level security;
alter table email_sync force row level security;
create policy tenant_isolation on email_sync using (app_sys() or business_id = app_biz()) with check (app_sys() or business_id = app_biz());
