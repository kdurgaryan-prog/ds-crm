-- DS CRM initial schema.
-- Every business-owned table carries business_id and is protected by row-level security.
-- The app sets `app.business_id` per transaction; internal workers/webhook routers set `app.system = 'on'`.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create or replace function app_biz() returns uuid language sql stable as $$
  select nullif(current_setting('app.business_id', true), '')::uuid
$$;
create or replace function app_sys() returns boolean language sql stable as $$
  select coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- ---------- tenancy & users ----------
create table businesses (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  public_key text unique not null default encode(gen_random_bytes(18), 'hex'), -- used by website widget/forms
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text not null,
  password_hash text not null,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table memberships (
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','sales','marketing','viewer')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create table sessions (
  id text primary key,                 -- sha256 of the cookie token
  user_id uuid not null references users(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  ip text, user_agent text
);

create table login_attempts (
  key text primary key, count int not null default 0, window_start timestamptz not null default now()
);

create table counters (
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  value bigint not null default 0,
  primary key (business_id, name)
);

-- ---------- contacts (leads & customers) ----------
create table contacts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  lead_no bigint not null,
  name text,
  company text,
  phone_e164 text,
  phone_raw text,
  email text,
  socials jsonb not null default '{}',          -- {"instagram":"@x","facebook":"..."}
  source text,                                   -- call, sms, whatsapp, messenger, instagram, webchat, website_form, import, manual, referral
  owner_user_id uuid references users(id),
  status text not null default 'New' check (status in ('New','Contacted','Waiting','Qualified','Quote Sent','Won','Lost')),
  product_type text,
  quantity int check (quantity is null or quantity >= 0),
  decoration text,                               -- DTF, Embroidery, Screen printing, Not sure
  colors text,
  sizes text,
  deadline date,
  industry text,
  employees int,
  current_apparel text,
  notes text,
  custom jsonb not null default '{}',
  -- communication permissions
  sms_marketing text not null default 'unknown' check (sms_marketing in ('unknown','opted_in','opted_out')),
  call_marketing text not null default 'unknown' check (call_marketing in ('unknown','express_written','opted_out')),
  dnc boolean not null default false,
  opted_out_at timestamptz,
  opt_out_channel text,
  timezone text,                                 -- IANA; null = unknown → strictest window
  preferred_language text not null default 'en',
  restrictions text,                             -- free text e.g. "text only after 3pm"
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  merged_into uuid references contacts(id),
  deleted_at timestamptz,
  unique (business_id, lead_no)
);
create index contacts_biz_activity on contacts (business_id, last_activity_at desc) where deleted_at is null and merged_into is null;
create index contacts_biz_phone on contacts (business_id, phone_e164);
create index contacts_search on contacts using gin ((coalesce(name,'') || ' ' || coalesce(company,'') || ' ' || coalesce(phone_e164,'') || ' ' || coalesce(email,'')) gin_trgm_ops);
create index contacts_biz_status on contacts (business_id, status);
create index contacts_biz_deadline on contacts (business_id, deadline);

-- verified identifiers used for dedupe and inbound routing
create table contact_identities (
  business_id uuid not null references businesses(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null check (kind in ('phone','whatsapp','messenger','instagram','webchat','email')),
  value text not null,
  verified boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (business_id, kind, value)
);
create index contact_identities_contact on contact_identities (contact_id);

create table duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  contact_a uuid not null references contacts(id) on delete cascade,
  contact_b uuid not null references contacts(id) on delete cascade,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','merged','dismissed')),
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, contact_a, contact_b)
);

create table dnc_numbers (
  business_id uuid not null references businesses(id) on delete cascade,
  phone_e164 text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  primary key (business_id, phone_e164)
);

create table files (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  order_id uuid,
  kind text not null default 'attachment' check (kind in ('logo','design','attachment','mockup','marketing')),
  filename text not null,
  mime text,
  size bigint,
  storage_key text not null,
  marketing_permission text not null default 'none' check (marketing_permission in ('none','requested','granted','denied')),
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- ---------- tasks & activity ----------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  order_id uuid,
  title text not null,
  kind text not null default 'task' check (kind in ('task','callback','meeting','handoff','follow_up')),
  due_at timestamptz,
  assignee_user_id uuid references users(id),
  done_at timestamptz,
  created_by uuid references users(id),
  created_by_agent text,
  created_at timestamptz not null default now()
);
create index tasks_biz_due on tasks (business_id, done_at, due_at);

create table activities (   -- unified customer timeline
  id bigserial primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null,       -- message, call, quote, order, status, note, task, file, merge, ai
  ref_id uuid,
  summary text not null,
  data jsonb not null default '{}',
  actor_user_id uuid references users(id),
  actor_agent text,
  created_at timestamptz not null default now()
);
create index activities_contact on activities (contact_id, created_at desc);

-- ---------- channels, inbox ----------
create table channel_accounts (
  business_id uuid not null references businesses(id) on delete cascade,
  channel text not null check (channel in ('sms','voice','whatsapp','messenger','instagram','webchat','website_forms','ai','shopify')),
  status text not null default 'needs_setup' check (status in ('connected','needs_setup','error')),
  config jsonb not null default '{}',        -- non-secret config (numbers, page ids)
  secrets_enc text,                          -- AES-256-GCM encrypted JSON (server key)
  last_error text,
  last_checked_at timestamptz,
  primary key (business_id, channel)
);

-- global routing table (no RLS): which business owns an inbound address
create table channel_routes (
  provider text not null,       -- twilio_number, whatsapp_number, fb_page, ig_account, public_key
  address text not null,
  business_id uuid not null references businesses(id) on delete cascade,
  primary key (provider, address)
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  channel text not null,
  external_thread_id text,                 -- customer address on that channel
  assignee_user_id uuid references users(id),
  status text not null default 'open' check (status in ('open','pending','done')),
  ai_enabled boolean not null default true,
  ai_paused_reason text,
  language text not null default 'en',
  unread int not null default 0,
  needs_reply boolean not null default false,
  last_inbound_at timestamptz,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (business_id, channel, external_thread_id)
);
create index conversations_biz_last on conversations (business_id, last_message_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  channel text not null,
  body text,
  media jsonb not null default '[]',
  author_type text not null check (author_type in ('customer','user','ai','system')),
  author_user_id uuid references users(id),
  status text not null check (status in ('received','queued','sending','sent','delivered','failed','unknown','sandbox','blocked')),
  status_detail text,
  provider_message_id text,
  idempotency_key text,
  purpose text not null default 'conversational' check (purpose in ('conversational','transactional','marketing')),
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);
create index messages_conv on messages (conversation_id, created_at);
create unique index messages_provider_id on messages (business_id, channel, provider_message_id) where provider_message_id is not null;

create table canned_replies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- ---------- calls ----------
create table calls (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  direction text not null check (direction in ('inbound','outbound')),
  from_number text, to_number text,
  provider_call_sid text,
  status text not null default 'initiated',   -- initiated, ringing, in-progress, completed, busy, no-answer, failed, canceled, missed
  handled_by text not null default 'user' check (handled_by in ('user','ai')),
  user_id uuid references users(id),
  campaign_id uuid,
  started_at timestamptz, ended_at timestamptz, duration_sec int,
  recording_url text, recording_sid text,
  transcript jsonb not null default '[]',
  summary text,
  outcome text,
  next_action text,
  handoff_reason text,
  post_call_sms text,           -- null, pending, sent, failed, blocked, sandbox
  created_at timestamptz not null default now()
);
create unique index calls_sid on calls (business_id, provider_call_sid) where provider_call_sid is not null;
create index calls_biz_created on calls (business_id, created_at desc);

-- ---------- sales ----------
create table price_list (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  sku text not null,
  name text not null,
  product_type text not null,
  decoration text not null,
  min_qty int not null default 1,
  unit_price numeric(10,2) not null check (unit_price >= 0),
  active boolean not null default true,
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, sku, min_qty)
);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  quote_no bigint not null,
  contact_id uuid not null references contacts(id),
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','sent','accepted','declined','expired')),
  tax_rate numeric(6,4) not null default 0,
  shipping numeric(10,2) not null default 0,
  production_days int,
  due_date date,
  valid_until date,
  notes text,
  subtotal numeric(12,2) not null default 0,
  tax numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  created_by uuid references users(id),
  created_by_agent text,
  approved_by uuid references users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, quote_no)
);

create table quote_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  quote_id uuid not null references quotes(id) on delete cascade,
  price_item_id uuid references price_list(id),
  description text not null,
  product_type text,
  decoration text,
  color text,
  sizes text,
  qty int not null check (qty > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null,
  position int not null default 0
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  order_no bigint not null,
  contact_id uuid not null references contacts(id),
  quote_id uuid unique references quotes(id),
  status text not null default 'New' check (status in ('New','Awaiting Artwork','Awaiting Approval','Awaiting Payment','In Production','Quality Check','Ready','Delivered','Canceled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','deposit','paid','refunded')),
  amount_paid numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  deadline date,
  production_notes text,
  owner_user_id uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, order_no)
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  description text not null,
  product_type text, decoration text, color text, sizes text,
  qty int not null, unit_price numeric(10,2) not null, line_total numeric(12,2) not null,
  position int not null default 0
);

create table design_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  version int not null,
  file_id uuid references files(id),
  notes text,
  customer_approved_at timestamptz,
  approval_note text,          -- how approval was received e.g. "SMS reply 'approved'"
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (order_id, version)
);

-- ---------- marketing ----------
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  kind text not null check (kind in ('social_post','ad_copy','sms_blast','whatsapp_blast','call_campaign','image_prompt','video_script','content_calendar')),
  title text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','scheduled','running','paused','stopped','published','completed','failed','rejected')),
  content jsonb not null default '{}',   -- {text, files:[], channels:[], audience:{...}, schedule_at, template_sid}
  approval_hash text,                    -- sha256 of content at approval time
  created_by uuid references users(id),
  created_by_agent text,
  approved_by uuid references users(id),
  approved_at timestamptz,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table campaign_recipients (
  business_id uuid not null references businesses(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','skipped','queued','sent','failed','sandbox','called')),
  skip_reason text,
  updated_at timestamptz not null default now(),
  primary key (campaign_id, contact_id)
);

-- ---------- AI, audit, jobs ----------
create table agent_actions (
  id bigserial primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  agent text not null,                  -- natalie | arev
  action text not null,
  based_on jsonb not null default '{}', -- references to data used
  change jsonb not null default '{}',
  approval_required boolean not null default false,
  approval_status text,                 -- pending, approved, rejected, n/a
  result text not null,                 -- ok, blocked, error, skipped
  detail text,
  created_at timestamptz not null default now()
);
create index agent_actions_biz on agent_actions (business_id, created_at desc);

create table audit_log (
  id bigserial primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  actor_user_id uuid references users(id),
  actor_agent text,
  action text not null,
  entity text,
  entity_id text,
  before jsonb, after jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_biz on audit_log (business_id, created_at desc);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  idempotency_key text,
  status text not null default 'pending' check (status in ('pending','running','done','failed','dead','canceled')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);
create index jobs_due on jobs (status, run_at);

create table webhook_events (           -- dedupe of provider retries (global)
  provider text not null,
  event_id text not null,
  business_id uuid,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create table custom_fields (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  entity text not null default 'contact',
  key text not null,
  label text not null,
  type text not null default 'text' check (type in ('text','number','date','select','checkbox')),
  options jsonb not null default '[]',
  position int not null default 0,
  unique (business_id, entity, key)
);

create table ui_views (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  table_key text not null,
  name text not null,
  config jsonb not null,        -- columns [{key,width,hidden}], filters, sort, rowHeight
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_prefs (
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  prefs jsonb not null default '{}',     -- theme: font, size, weight, accent color, density
  primary key (business_id, user_id)
);

create table backup_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  file text, size_bytes bigint,
  ok boolean, verified boolean, detail text
);

-- ---------- row level security ----------
do $$
declare t text;
begin
  foreach t in array array['counters','contacts','contact_identities','duplicate_candidates','dnc_numbers','files','tasks','activities',
    'channel_accounts','conversations','messages','canned_replies','calls','price_list','quotes','quote_items','orders','order_items',
    'design_versions','campaigns','campaign_recipients','agent_actions','audit_log','jobs','custom_fields','ui_views','user_prefs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (app_sys() or business_id = app_biz()) with check (app_sys() or business_id = app_biz())', t);
  end loop;
end $$;
