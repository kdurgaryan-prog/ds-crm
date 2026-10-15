-- Identities of already-deleted customers no longer point at them (see routes/contacts.js delete handler).
select set_config('app.system', 'on', true);
delete from contact_identities i using contacts c where c.id = i.contact_id and c.deleted_at is not null;
