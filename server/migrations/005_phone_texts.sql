-- "Text from my phone" queue: a person sends each text from their own phone (one tap each).
-- The CRM prepares the list, fills in the text, skips people who must not be texted, and records what was sent.
create table phone_text_batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  template text not null,
  filters jsonb not null default '{}',
  excluded jsonb not null default '{}',     -- counts of people left out, by reason
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table phone_text_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  batch_id uuid not null references phone_text_batches(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  position int not null,
  status text not null default 'pending',  -- pending, sent, skipped, blocked
  body text,                               -- the exact text shown when it was opened
  detail text,
  claimed_by uuid references users(id),     -- who has it open right now (so two people never text the same person)
  claimed_at timestamptz,
  done_by uuid references users(id),
  done_at timestamptz,
  unique (batch_id, contact_id)
);
create index phone_text_items_next on phone_text_items (batch_id, status, position);
create index phone_text_items_contact on phone_text_items (contact_id, status, done_at desc);

do $$
declare t text;
begin
  foreach t in array array['phone_text_batches','phone_text_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (app_sys() or business_id = app_biz()) with check (app_sys() or business_id = app_biz())', t);
  end loop;
end $$;
