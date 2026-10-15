// "Text from my phone": the CRM prepares a list and the text; a person sends each one from their own phone.
// Nothing here sends a message. The CRM only records what the person says they sent.
import { Router } from 'express';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, badRequest, notFound, AppError } from '../lib/http.js';
import { buildContactQuery } from './contacts.js';
import { getSettings } from '../services/settings.js';
import { withinCampaignHours, classifyKeyword, timezoneFor } from '../services/compliance.js';
import { fillTemplate } from '../services/intro.js';
import { audit, activity } from '../services/audit.js';
import { getContact } from '../services/contacts.js';

const r = Router();
const MAX_BATCH = 2000;
const CLAIM_MINUTES = 10;

/** Why this person must not get a text from a phone list right now (null = fine). */
export function phoneTextBlock(contact, { dncListed = false, lastSentAt = null, repeatDays = 30, now = new Date() } = {}) {
  if (!contact.phone_e164) return 'No phone number';
  if (contact.deleted_at || contact.merged_into) return 'Customer removed or merged';
  if (contact.dnc || dncListed) return 'On Do Not Call list';
  if (contact.opted_out_at || contact.sms_marketing === 'opted_out') return 'Asked not to be texted';
  if (lastSentAt && now - new Date(lastSentAt) < repeatDays * 86400_000) return `Already texted in the last ${repeatDays} days`;
  return null;
}

/** The customer record that is in use now: follows merges ("A was merged into B"); null if deleted. */
async function currentContact(c, id) {
  let phone = null;
  for (let i = 0; i < 10 && id; i++) {
    const ct = (await c.query('select * from contacts where id = $1', [id])).rows[0];
    if (!ct) break;
    phone = ct.phone_e164 || phone;
    if (ct.deleted_at) break;
    if (!ct.merged_into) return ct;
    id = ct.merged_into;
  }
  // Deleted and added again: the live customer with the same phone number is the same person.
  if (!phone) return null;
  return (await c.query(`select * from contacts where phone_e164 = $1 and deleted_at is null and merged_into is null order by created_at desc limit 1`, [phone])).rows[0] || null;
}

async function blockFor(c, contact, s, { allowRepeat = false } = {}) {
  const dncListed = contact.phone_e164 ? (await c.query('select 1 from dnc_numbers where phone_e164 = $1', [contact.phone_e164])).rowCount > 0 : false;
  // by phone number, so a merged or re-added record cannot be texted again early
  const last = (await c.query(`select max(i.done_at) t from phone_text_items i join contacts ct on ct.id = i.contact_id
     where i.status = 'sent' and (i.contact_id = $1 or ct.phone_e164 = $2)`, [contact.id, contact.phone_e164 || ''])).rows[0].t;
  return phoneTextBlock(contact, { dncListed, lastSentAt: allowRepeat ? null : last, repeatDays: s.phoneText.repeatDays });
}

async function sentToday(c, tz) {
  return (await c.query(`select count(*)::int n from phone_text_items where status = 'sent'
    and done_at >= (date_trunc('day', now() at time zone $1) at time zone $1)`, [tz])).rows[0].n;
}

const batchInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  ids: z.array(z.string().uuid()).max(MAX_BATCH).optional(),
  template: z.string().min(10).max(640).optional(),
  allowRepeat: z.boolean().optional(),   // owner/admin: text again before the waiting period ends (never overrides opt-out or Do Not Call)
});

r.post('/batches', requirePerm('inbox.reply'), async (req, res) => {
  const b = parse(batchInput, req.body);
  if (!b.ids?.length && !b.filters) throw badRequest('Choose customers first.');
  if (b.template && !/stop/i.test(b.template)) throw badRequest('The text must tell people how to opt out (for example "Reply STOP and we won\'t text again").');
  if (b.allowRepeat && !['owner', 'admin'].includes(req.ctx.role)) throw new AppError(403, 'Only the owner or an admin can text someone again this soon.');
  const out = await withBiz(req.ctx.businessId, async c => {
    const s = await getSettings(c, req.ctx.businessId);
    const { where, vals, order } = buildContactQuery(b.ids?.length ? { ids: b.ids } : { ...b.filters, page: undefined });
    const rows = (await c.query(`select c.* from contacts c where ${where} order by ${order} limit ${MAX_BATCH + 1}`, vals)).rows;
    if (rows.length > MAX_BATCH) throw badRequest(`This list has more than ${MAX_BATCH.toLocaleString()} customers.`, { hint: 'Narrow it down with filters (for example by industry or source).' });
    if (!rows.length) throw badRequest('No customers match this list.');
    // People already waiting in another open list are not added twice.
    const queuedRows = (await c.query(`select i.contact_id, i.batch_id from phone_text_items i join phone_text_batches b on b.id = i.batch_id
      where i.status = 'pending' and b.closed_at is null and i.contact_id = any($1)`, [rows.map(x => x.id)])).rows;
    const queued = new Set(queuedRows.map(x => x.contact_id));
    const openLists = [...new Set(queuedRows.map(x => x.batch_id))];
    const excluded = {}; const ok = [];
    for (const ct of rows) {
      const why = queued.has(ct.id) ? 'Already in another open list' : await blockFor(c, ct, s, { allowRepeat: b.allowRepeat });
      if (why) excluded[why] = (excluded[why] || 0) + 1; else ok.push(ct);
    }
    if (!ok.length) return { batch: null, added: 0, excluded, openListId: openLists.length === 1 ? openLists[0] : undefined };
    const name = b.name || `List of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: s.timezone })}`;
    const batch = (await c.query(`insert into phone_text_batches (business_id, name, template, filters, excluded, created_by, allow_repeat) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [req.ctx.businessId, name, b.template || null, b.ids?.length ? { ids: b.ids.length } : b.filters, excluded, req.ctx.userId, !!b.allowRepeat])).rows[0];
    for (const [i, ct] of ok.entries()) {
      await c.query(`insert into phone_text_items (business_id, batch_id, contact_id, position) values ($1,$2,$3,$4)`, [req.ctx.businessId, batch.id, ct.id, i + 1]);
    }
    await audit(c, req.ctx, 'phone_texts.create', 'phone_text_batch', batch.id, null, { name, added: ok.length, excluded });
    if (b.allowRepeat) await audit(c, req.ctx, 'phone_texts.allow_repeat', 'phone_text_batch', batch.id, null, { added: ok.length });
    return { batch, added: ok.length, excluded, openListId: openLists.length === 1 ? openLists[0] : undefined };
  });
  res.status(out.batch ? 201 : 200).json(out);
});

r.get('/batches', requirePerm('inbox.reply'), async (req, res) => {
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(
    `select b.id, b.name, b.created_at, b.closed_at, b.excluded, u.name created_by_name,
            count(i.*)::int total,
            count(*) filter (where i.status = 'sent')::int sent,
            count(*) filter (where i.status = 'pending')::int pending,
            count(*) filter (where i.status in ('skipped','blocked'))::int skipped,
            (select jsonb_object_agg(r.detail, r.n) from (select coalesce(x.detail, 'Skipped') detail, count(*)::int n from phone_text_items x
               where x.batch_id = b.id and x.status in ('skipped','blocked') group by 1) r) skip_reasons
       from phone_text_batches b left join phone_text_items i on i.batch_id = b.id left join users u on u.id = b.created_by
      group by b.id, u.name order by b.closed_at nulls first, b.created_at desc limit 100`)).rows);
  res.json(rows);
});

/** The next person to text. Rechecks everything at this moment, because people opt out between list creation and sending. */
r.get('/batches/:id/next', requirePerm('inbox.reply'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const batch = (await c.query('select * from phone_text_batches where id = $1', [req.params.id])).rows[0];
    if (!batch) throw notFound('List not found.');
    const s = await getSettings(c, req.ctx.businessId);
    const counts = (await c.query(`select count(*)::int total, count(*) filter (where status = 'sent')::int sent, count(*) filter (where status = 'pending')::int pending,
      count(*) filter (where status in ('skipped','blocked'))::int skipped from phone_text_items where batch_id = $1`, [batch.id])).rows[0];
    const today = await sentToday(c, s.campaignHours.timezone);
    const base = { batch: { id: batch.id, name: batch.name, closed: !!batch.closed_at }, counts, sentToday: today, dailyLimit: s.phoneText.dailyLimit };
    if (batch.closed_at) return { ...base, done: true };
    if (today >= s.phoneText.dailyLimit) return { ...base, paused: `Today's limit of ${s.phoneText.dailyLimit} texts is reached. Continue tomorrow.` };
    for (let guard = 0; guard < 500; guard++) {
      const item = (await c.query(`select * from phone_text_items where batch_id = $1 and status = 'pending'
          and (claimed_by is null or claimed_by = $2 or claimed_at < now() - make_interval(mins => $3))
        order by (claimed_by = $2) desc nulls last, position limit 1 for update skip locked`, [batch.id, req.ctx.userId, CLAIM_MINUTES])).rows[0];
      if (!item) return { ...base, done: counts.pending === 0, waiting: counts.pending > 0 ? 'The remaining people are open on a teammate\'s screen.' : undefined };
      let ct = (await c.query('select * from contacts where id = $1', [item.contact_id])).rows[0];
      if (ct.merged_into || ct.deleted_at) {   // merged or re-added since the list was made: text the record in use now, unless it is already in this list
        const now = await currentContact(c, ct.id);
        const dup = now && (await c.query('select 1 from phone_text_items where batch_id = $1 and contact_id = $2', [batch.id, now.id])).rowCount;
        if (now && !dup) { await c.query('update phone_text_items set contact_id = $2 where id = $1', [item.id, now.id]); ct = now; }
      }
      const why = await blockFor(c, ct, s, { allowRepeat: batch.allow_repeat });
      if (why) {
        await c.query(`update phone_text_items set status = 'blocked', detail = $2, done_at = now() where id = $1`, [item.id, why]);
        counts.pending--; counts.skipped++;
        continue;
      }
      const hours = withinCampaignHours(s.campaignHours, timezoneFor(ct));
      if (!hours.ok) return { ...base, paused: `Outside sending hours: ${hours.reason}. Texts can go ${s.campaignHours.start}–${s.campaignHours.end} on weekdays, in the customer's time too.` };
      const body = fillTemplate(s.phoneText.template, ct);   // always the text in Settings right now
      await c.query(`update phone_text_items set claimed_by = $2, claimed_at = now(), body = $3 where id = $1`, [item.id, req.ctx.userId, body]);
      return { ...base, item: { id: item.id, position: item.position, body,
        contact: { id: ct.id, lead_no: ct.lead_no, name: ct.name, company: ct.company, phone_e164: ct.phone_e164, industry: ct.industry, status: ct.status } } };
    }
    return { ...base, retry: true, waiting: 'Many people in this list could not be texted and were skipped. Press Check again to continue.' };   // progress is kept
  });
  res.json(out);
});

async function loadItem(c, id) {
  const it = (await c.query('select * from phone_text_items where id = $1 for update', [id])).rows[0];
  if (!it) throw notFound('This person is no longer in the list.');
  return it;
}

r.post('/items/:id/sent', requirePerm('inbox.reply'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const it = await loadItem(c, req.params.id);
    if (it.status === 'sent') return { ok: true, already: true };       // pressing twice never records twice
    if (it.status !== 'pending') throw badRequest(`This person was ${it.status === 'blocked' ? `not allowed to be texted (${it.detail})` : 'skipped'}.`);
    if (it.claimed_by && it.claimed_by !== req.ctx.userId) throw badRequest('A teammate has this person open.');
    if (!it.body) throw badRequest('Open this person first.');
    const s = await getSettings(c, req.ctx.businessId);
    if (await sentToday(c, s.campaignHours.timezone) >= s.phoneText.dailyLimit) throw badRequest(`Today's limit of ${s.phoneText.dailyLimit} texts is reached.`);
    await c.query(`update phone_text_items set status = 'sent', done_by = $2, done_at = now(), claimed_by = null where id = $1`, [it.id, req.ctx.userId]);
    const ct = (await c.query('select * from contacts where id = $1', [it.contact_id])).rows[0];
    await activity(c, req.ctx, ct.id, 'message', `Texted from ${req.ctx.name}'s phone: "${it.body}"`, { refId: it.id, data: { channel: 'staff_phone', batchId: it.batch_id } });
    if (ct.status === 'New') {
      await c.query(`update contacts set status = 'Contacted' where id = $1`, [ct.id]);
      await activity(c, req.ctx, ct.id, 'status', 'Status New → Contacted');
    }
    return { ok: true };
  });
  res.json(out);
});

/** "It did not actually go out": put the person back so they can be texted again from this list. */
r.post('/items/:id/undo', requirePerm('inbox.reply'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    const it = await loadItem(c, req.params.id);
    if (it.status === 'pending') return;
    if (it.status === 'blocked') throw badRequest(`This person cannot be texted: ${it.detail}.`);
    if (it.done_by !== req.ctx.userId && !['owner', 'admin'].includes(req.ctx.role)) throw badRequest('Only the person who marked it can undo it.');
    if (new Date(it.done_at) < Date.now() - 24 * 3600_000) throw badRequest('This was marked more than a day ago and cannot be undone.');
    await c.query(`update phone_text_items set status = 'pending', detail = null, done_by = null, done_at = null, claimed_by = $2, claimed_at = now() where id = $1`, [it.id, req.ctx.userId]);
    if (it.status === 'sent') await activity(c, req.ctx, it.contact_id, 'message', `Marked as not sent (${req.ctx.name}): the text did not go out from the phone.`, { refId: it.id, data: { channel: 'staff_phone' } });
  });
  res.json({ ok: true });
});

r.post('/items/:id/skip', requirePerm('inbox.reply'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(200).default('Skipped') }), req.body || {});
  await withBiz(req.ctx.businessId, async c => {
    const it = await loadItem(c, req.params.id);
    if (it.status !== 'pending') throw badRequest(it.status === 'sent' ? 'This person was already marked as sent.' : 'This person is no longer waiting.');
    if (it.claimed_by && it.claimed_by !== req.ctx.userId) throw badRequest('A teammate has this person open.');
    await c.query(`update phone_text_items set status = 'skipped', detail = $2, done_by = $3, done_at = now(), claimed_by = null where id = $1`, [it.id, reason, req.ctx.userId]);
    if (reason === 'Not a mobile number' || reason === 'Wrong number') await activity(c, req.ctx, it.contact_id, 'note', `Phone list: ${reason.toLowerCase()} (marked by ${req.ctx.name})`);
  });
  res.json({ ok: true });
});

/** Send a finished (or closed) list again: a new list with the same people, numbered "(2)", "(3)"…
 *  Owner/admin only, because it skips the usual waiting period. Opt-outs and Do Not Call stay excluded at send time. */
r.post('/batches/:id/again', requirePerm('inbox.reply'), async (req, res) => {
  if (!['owner', 'admin'].includes(req.ctx.role)) throw new AppError(403, 'Only the owner or an admin can send a list again.');
  const out = await withBiz(req.ctx.businessId, async c => {
    const old = (await c.query('select * from phone_text_batches where id = $1', [req.params.id])).rows[0];
    if (!old) throw notFound('List not found.');
    const raw = (await c.query(`select contact_id, status, detail from phone_text_items where batch_id = $1 order by position`, [old.id])).rows;
    const seen = new Set(); const items = [];
    for (const r of raw) {
      if (r.status === 'blocked' && r.detail !== 'Customer removed or merged') continue;
      if (r.status === 'skipped' && ['Not a mobile number', 'Wrong number'].includes(r.detail)) continue;   // never text those again
      const ct = await currentContact(c, r.contact_id);
      if (ct && !seen.has(ct.id)) { seen.add(ct.id); items.push({ contact_id: ct.id }); }
    }
    if (!items.length) {
      const why = (await c.query(`select coalesce(detail, 'Skipped') d, count(*)::int n from phone_text_items where batch_id = $1 group by 1`, [old.id])).rows;
      throw badRequest('Nobody in this list can be texted.', { hint: why.map(x => `${x.d} (${x.n})`).join(', ') });
    }
    const pendingElsewhere = (await c.query(`select count(*)::int n from phone_text_items i join phone_text_batches b on b.id = i.batch_id
      where i.status = 'pending' and b.closed_at is null and b.id <> $1 and i.contact_id = any($2)`, [old.id, items.map(x => x.contact_id)])).rows[0].n;
    if (pendingElsewhere) throw badRequest(`${pendingElsewhere} of these people are waiting in another open list.`, { hint: 'Finish or close that list first.' });
    const base = old.name.replace(/\s\(\d+\)$/, '');
    const names = (await c.query(`select name from phone_text_batches where name = $1 or left(name, length($1) + 2) = $1 || ' ('`, [base])).rows.map(x => x.name);
    const n = names.filter(x => x === base || /^ \(\d+\)$/.test(x.slice(base.length))).length;
    const name = `${base} (${n + 1})`;
    const batch = (await c.query(`insert into phone_text_batches (business_id, name, template, filters, excluded, created_by, allow_repeat) values ($1,$2,null,$3,'{}',$4,true) returning *`,
      [req.ctx.businessId, name, { againOf: old.id }, req.ctx.userId])).rows[0];
    for (const [i, it] of items.entries()) await c.query(`insert into phone_text_items (business_id, batch_id, contact_id, position) values ($1,$2,$3,$4)`, [req.ctx.businessId, batch.id, it.contact_id, i + 1]);
    await c.query(`update phone_text_batches set closed_at = coalesce(closed_at, now()) where id = $1`, [old.id]);
    await audit(c, req.ctx, 'phone_texts.again', 'phone_text_batch', batch.id, null, { from: old.id, added: items.length });
    return { batch, added: items.length };
  });
  res.status(201).json(out);
});

r.post('/batches/:id/close', requirePerm('inbox.reply'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    const n = (await c.query(`update phone_text_batches set closed_at = now() where id = $1 and closed_at is null returning id`, [req.params.id])).rowCount;
    if (n) await audit(c, req.ctx, 'phone_texts.close', 'phone_text_batch', req.params.id);
  });
  res.json({ ok: true });
});

/** A reply that came to someone's own phone: typed or pasted into the CRM. "STOP" and similar mark the person as opted out. */
export async function logPhoneReply(c, ctx, contactId, text) {
  const ct = await getContact(c, contactId);
  await activity(c, ctx, ct.id, 'message', `Replied to ${ctx.name}'s phone: "${text}"`, { data: { channel: 'staff_phone', direction: 'in' } });
  const kw = classifyKeyword(text);
  if (kw === 'opt_out') {
    await c.query(`update contacts set opted_out_at = now(), opt_out_channel = 'staff phone', sms_marketing = 'opted_out' where id = $1`, [ct.id]);
    await c.query(`update phone_text_items set status = 'blocked', detail = 'Asked not to be texted', done_at = now() where contact_id = $1 and status = 'pending'`, [ct.id]);
    await activity(c, ctx, ct.id, 'status', 'Asked not to be texted (reply to staff phone). Removed from all phone lists.');
    await audit(c, ctx, 'contact.opt_out', 'contact', ct.id, null, { via: 'staff phone' });
    return { optedOut: true };
  }
  return { optedOut: false };
}

export default r;
