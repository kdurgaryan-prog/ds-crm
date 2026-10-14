import { nextNumber } from '../db.js';
import { normalizePhone } from './compliance.js';
import { activity, audit } from './audit.js';
import { notFound, badRequest } from '../lib/http.js';

export const CONTACT_FIELDS = ['name', 'company', 'phone_raw', 'email', 'socials', 'source', 'owner_user_id', 'status', 'product_type', 'quantity',
  'decoration', 'colors', 'sizes', 'deadline', 'industry', 'employees', 'current_apparel', 'notes', 'custom', 'sms_marketing', 'call_marketing',
  'dnc', 'timezone', 'preferred_language', 'restrictions', 'title', 'address', 'city', 'county', 'zip'];

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

export async function getContact(c, id) {
  const r = (await c.query('select * from contacts where id = $1 and deleted_at is null', [id])).rows[0];
  if (!r) throw notFound('Customer not found.');
  if (r.merged_into) return getContact(c, r.merged_into);
  return r;
}

export async function addIdentity(c, ctx, contactId, kind, value) {
  if (!value) return;
  await c.query(`insert into contact_identities (business_id, contact_id, kind, value) values ($1,$2,$3,$4)
                 on conflict (business_id, kind, value) do nothing`, [ctx.businessId, contactId, kind, String(value)]);
}

/** Exact match on verified identifiers only (normalized phone, channel IDs). Never by name. */
export async function findByIdentity(c, kind, value) {
  if (!value) return null;
  const r = (await c.query(
    `select c.* from contact_identities i join contacts c on c.id = i.contact_id
      where i.kind = $1 and i.value = $2 and c.deleted_at is null order by c.merged_into nulls first limit 1`, [kind, String(value)])).rows[0];
  if (!r) return null;
  return r.merged_into ? getContact(c, r.merged_into) : r;
}

/**
 * Create a contact. If the normalized phone (or another verified identity) already exists, returns that
 * contact instead with {existing:true}. Similar names/companies only produce a review item, never a merge.
 */
export async function createContact(c, ctx, input, { identities = [] } = {}) {
  const phone = normalizePhone(input.phone_raw ?? input.phone);
  if ((input.phone_raw || input.phone) && !phone) throw badRequest('That phone number does not look valid.', { hint: 'Use a full number, e.g. (213) 555-0142 or +1 213 555 0142.', details: [{ field: 'phone', message: 'Invalid phone number' }] });
  const ids = [...identities];
  if (phone) ids.unshift({ kind: 'phone', value: phone });
  if (input.email) ids.push({ kind: 'email', value: String(input.email).toLowerCase().trim() });
  for (const id of ids) {
    const hit = await findByIdentity(c, id.kind, id.value);
    if (hit) {
      for (const other of ids) await addIdentity(c, ctx, hit.id, other.kind, other.value);
      return { contact: hit, existing: true, matchedOn: id.kind };
    }
  }
  const leadNo = await nextNumber(c, ctx.businessId, 'lead');
  const row = { ...input };
  delete row.phone;
  const cols = ['business_id', 'lead_no', 'phone_e164'];
  const vals = [ctx.businessId, leadNo, phone];
  for (const f of CONTACT_FIELDS) if (row[f] !== undefined) { cols.push(f); vals.push(row[f] === '' ? null : row[f]); }
  if (row.email) vals[cols.indexOf('email')] = String(row.email).toLowerCase().trim();
  const sql = `insert into contacts (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) returning *`;
  const contact = (await c.query(sql, vals)).rows[0];
  for (const id of ids) await addIdentity(c, ctx, contact.id, id.kind, id.value);
  await activity(c, ctx, contact.id, 'status', `Lead ${leadNo} created${contact.source ? ` from ${contact.source}` : ''}`);
  await audit(c, ctx, 'contact.create', 'contact', contact.id, null, { lead_no: leadNo });
  await flagPossibleDuplicates(c, ctx, contact);
  return { contact, existing: false };
}

/** Suspicious-but-not-certain matches go to a review queue. */
export async function flagPossibleDuplicates(c, ctx, contact) {
  const name = normName(contact.name); const company = normName(contact.company);
  if (!name && !company) return [];
  const { rows } = await c.query(
    `select id, name, company, phone_e164, email from contacts
      where id <> $1 and deleted_at is null and merged_into is null
        and ( ($2 <> '' and lower(regexp_replace(coalesce(name,''), '[^a-zA-Z0-9]+', ' ', 'g')) = $2)
           or ($3 <> '' and lower(regexp_replace(coalesce(company,''), '[^a-zA-Z0-9]+', ' ', 'g')) = $3) )
      limit 10`, [contact.id, name, company]);
  const flagged = [];
  for (const r of rows) {
    const reason = [normName(r.name) === name && name ? 'same name' : null, normName(r.company) === company && company ? 'same company' : null].filter(Boolean).join(' + ');
    const [a, b] = [contact.id, r.id].sort();
    const ins = await c.query(`insert into duplicate_candidates (business_id, contact_a, contact_b, reason) values ($1,$2,$3,$4)
                               on conflict do nothing returning id`, [ctx.businessId, a, b, `Possible duplicate: ${reason} (different phone numbers — please review)`]);
    if (ins.rows[0]) flagged.push(ins.rows[0].id);
  }
  return flagged;
}

export async function updateContact(c, ctx, id, patch) {
  const before = await getContact(c, id);
  const sets = []; const vals = [before.id];
  for (const f of CONTACT_FIELDS) {
    if (patch[f] === undefined) continue;
    let v = patch[f] === '' ? null : patch[f];
    if (f === 'email' && v) v = String(v).toLowerCase().trim();
    vals.push(v); sets.push(`${f} = $${vals.length}`);
  }
  if (patch.phone !== undefined || patch.phone_raw !== undefined) {
    const raw = patch.phone ?? patch.phone_raw;
    const e164 = raw ? normalizePhone(raw) : null;
    if (raw && !e164) throw badRequest('That phone number does not look valid.', { details: [{ field: 'phone', message: 'Invalid phone number' }] });
    if (e164) {
      const other = await findByIdentity(c, 'phone', e164);
      if (other && other.id !== before.id) throw badRequest(`This phone number already belongs to Lead ${other.lead_no}${other.name ? ` (${other.name})` : ''}.`, { hint: 'Open that customer, or merge the two records.', code: 'phone_taken' });
    }
    vals.push(e164); sets.push(`phone_e164 = $${vals.length}`);
    vals.push(raw || null); sets.push(`phone_raw = $${vals.length}`);
  }
  if (patch.dnc === true) sets.push('opted_out_at = coalesce(opted_out_at, now())');
  if (!sets.length) return before;
  const after = (await c.query(`update contacts set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, vals)).rows[0];
  if (after.phone_e164 && after.phone_e164 !== before.phone_e164) await addIdentity(c, ctx, after.id, 'phone', after.phone_e164);
  if (after.email && after.email !== before.email) await addIdentity(c, ctx, after.id, 'email', after.email);
  if (before.status !== after.status) await activity(c, ctx, after.id, 'status', `Status: ${before.status} → ${after.status}`, { data: { from: before.status, to: after.status } });
  const changed = Object.fromEntries(Object.keys(patch).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => [k, after[k]]));
  if (Object.keys(changed).length) await audit(c, ctx, 'contact.update', 'contact', after.id, Object.fromEntries(Object.keys(changed).map(k => [k, before[k]])), changed);
  return after;
}

/** Merge `fromId` into `intoId`: moves history, keeps filled fields, records it. */
export async function mergeContacts(c, ctx, intoId, fromId) {
  if (intoId === fromId) throw badRequest('Choose two different customers to merge.');
  const into = await getContact(c, intoId); const from = await getContact(c, fromId);
  const fill = {};
  for (const f of ['name', 'company', 'email', 'product_type', 'quantity', 'decoration', 'colors', 'sizes', 'deadline', 'industry', 'employees', 'current_apparel', 'timezone', 'title', 'address', 'city', 'county', 'zip']) {
    if ((into[f] === null || into[f] === '') && from[f] !== null && from[f] !== '') fill[f] = from[f];
  }
  const notes = [into.notes, from.notes].filter(Boolean).join('\n---\n') || null;
  // keep the most restrictive communication permissions
  const strict = {
    dnc: into.dnc || from.dnc,
    opted_out_at: into.opted_out_at || from.opted_out_at,
    sms_marketing: [into.sms_marketing, from.sms_marketing].includes('opted_out') ? 'opted_out' : into.sms_marketing === 'opted_in' && from.sms_marketing !== 'opted_out' ? 'opted_in' : from.sms_marketing,
    call_marketing: [into.call_marketing, from.call_marketing].includes('opted_out') ? 'opted_out' : into.call_marketing,
  };
  const sets = Object.entries({ ...fill, ...strict, notes, socials: { ...from.socials, ...into.socials }, custom: { ...from.custom, ...into.custom } });
  await c.query(`update contacts set ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, phone_e164 = coalesce(phone_e164, $${sets.length + 2}), updated_at = now() where id = $1`,
    [into.id, ...sets.map(([, v]) => v), from.phone_e164]);
  for (const t of ['conversations', 'messages', 'calls', 'tasks', 'activities', 'quotes', 'orders', 'files', 'campaign_recipients']) {
    if (t === 'campaign_recipients') {
      await c.query('delete from campaign_recipients where contact_id = $1 and campaign_id in (select campaign_id from campaign_recipients where contact_id = $2)', [from.id, into.id]);
    }
    await c.query(`update ${t} set contact_id = $1 where contact_id = $2`, [into.id, from.id]);
  }
  await c.query(`update contact_identities set contact_id = $1 where contact_id = $2`, [into.id, from.id]);
  await c.query(`update contacts set merged_into = $1, updated_at = now() where id = $2`, [into.id, from.id]);
  await c.query(`update duplicate_candidates set status = 'merged', resolved_by = $3, resolved_at = now()
                  where status = 'pending' and ((contact_a = $1 and contact_b = $2) or (contact_a = $2 and contact_b = $1))`, [into.id, from.id, ctx.userId || null]);
  await activity(c, ctx, into.id, 'merge', `Merged Lead ${from.lead_no} into this record`, { refId: from.id });
  await audit(c, ctx, 'contact.merge', 'contact', into.id, { merged: from.id, lead_no: from.lead_no }, fill);
  return getContact(c, into.id);
}

/** Find or create the contact behind an inbound message/call. */
export async function resolveInboundContact(c, ctx, { channel, address, phone, name, source }) {
  const kindFor = { sms: 'phone', voice: 'phone', whatsapp: 'whatsapp', messenger: 'messenger', instagram: 'instagram', webchat: 'webchat' };
  const kind = kindFor[channel];
  const e164 = phone ? normalizePhone(phone) : null;
  let contact = (kind && address ? await findByIdentity(c, kind, kind === 'phone' ? e164 : address) : null)
    || (e164 ? await findByIdentity(c, 'phone', e164) : null);
  if (contact) {
    if (kind && address) await addIdentity(c, ctx, contact.id, kind, kind === 'phone' ? e164 : address);
    return { contact, created: false };
  }
  const identities = kind && kind !== 'phone' && address ? [{ kind, value: address }] : [];
  const r = await createContact(c, ctx, { name: name || null, phone_raw: e164 || undefined, source: source || channel }, { identities });
  return { contact: r.contact, created: !r.existing };
}
