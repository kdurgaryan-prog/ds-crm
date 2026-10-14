import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, badRequest, notFound } from '../lib/http.js';
import { createContact, updateContact, getContact, mergeContacts, flagPossibleDuplicates } from '../services/contacts.js';
import { normalizePhone } from '../services/compliance.js';
import { audit, activity } from '../services/audit.js';
import { saveBuffer, isAllowedMime, MAX_UPLOAD } from '../services/files.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 10 } });

export const STATUSES = ['New', 'Contacted', 'Waiting', 'Qualified', 'Quote Sent', 'Won', 'Lost'];
// Spreadsheet headers like "License #", "Business Name", "ZIP Code" become license, business_name, zip_code.
const normHeader = h => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export async function readImportFile(file) {
  const isXlsx = /\.xlsx$/i.test(file.originalname || '') || /spreadsheetml/.test(file.mimetype || '');
  if (isXlsx) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(file.buffer); } catch (e) { throw badRequest(`This Excel file could not be opened: ${e.message}`, { hint: 'Save it again in Excel as .xlsx, or as CSV UTF-8.' }); }
    const ws = wb.worksheets.find(w => w.actualRowCount > 0);
    if (!ws) return [];
    let header = null; const out = [];
    ws.eachRow({ includeEmpty: false }, row => {
      const cells = []; for (let i = 1; i <= ws.columnCount; i++) cells.push(String(row.getCell(i).text ?? '').trim());
      if (!header) { header = cells.map(normHeader); return; }
      if (cells.every(v => !v)) return;
      out.push(Object.fromEntries(header.map((h, i) => [h, cells[i] || ''])));
    });
    return out;
  }
  if (/\.xls$/i.test(file.originalname || '')) throw badRequest('Old Excel files (.xls) cannot be read.', { hint: 'In Excel: File → Save As → Excel Workbook (.xlsx) or CSV UTF-8.' });
  try { return csvParse(file.buffer, { columns: h => h.map(normHeader), skip_empty_lines: true, trim: true, bom: true, delimiter: [',', '\t', ';'], relax_column_count: true }); }
  catch (e) { throw badRequest(`This file could not be read: ${e.message}`, { hint: 'Use an Excel file (.xlsx) or CSV UTF-8.' }); }
}
const normZip = v => { const m = /^\s*(\d{5})(?:-?(\d{4}))?/.exec(String(v || '').padStart(5, '0')); return v ? (m ? m[1] + (m[2] ? `-${m[2]}` : '') : null) : null; };
const contactInput = z.object({
  name: z.string().max(160).nullish(), company: z.string().max(160).nullish(), phone: z.string().max(40).nullish(),
  email: z.string().email('Enter a valid email').max(200).nullish().or(z.literal('')),
  socials: z.record(z.string(), z.string().max(200)).optional(), source: z.string().max(60).nullish(), owner_user_id: z.string().uuid().nullish(),
  status: z.enum(STATUSES).optional(), product_type: z.string().max(80).nullish(), quantity: z.coerce.number().int().min(0).max(1_000_000).nullish(),
  decoration: z.string().max(60).nullish(), colors: z.string().max(300).nullish(), sizes: z.string().max(300).nullish(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date').nullish().or(z.literal('')), industry: z.string().max(80).nullish(),
  employees: z.coerce.number().int().min(0).nullish(), current_apparel: z.string().max(300).nullish(), notes: z.string().max(20000).nullish(),
  custom: z.record(z.string(), z.any()).optional(), sms_marketing: z.enum(['unknown', 'opted_in', 'opted_out']).optional(),
  call_marketing: z.enum(['unknown', 'express_written', 'opted_out']).optional(), dnc: z.boolean().optional(),
  title: z.string().max(120).nullish(), address: z.string().max(300).nullish(), city: z.string().max(100).nullish(),
  county: z.string().max(100).nullish(), zip: z.string().max(10).regex(/^\d{5}(-\d{4})?$/, 'Use a 5-digit ZIP').nullish().or(z.literal('')),
  license_no: z.string().max(40).nullish(), business_type: z.string().max(80).nullish(), industry_type: z.string().max(120).nullish(), other_personnel: z.string().max(2000).nullish(),
  timezone: z.string().max(60).nullish(), preferred_language: z.enum(['en', 'hy', 'ru', 'es']).optional(), restrictions: z.string().max(500).nullish(),
});

// Server-side list: search, filters, sorting and paging (handles large customer bases).
const SORTABLE = { lead_no: 'c.lead_no', name: 'c.name', company: 'c.company', created_at: 'c.created_at', last_activity_at: 'c.last_activity_at', status: 'c.status', quantity: 'c.quantity', deadline: 'c.deadline', source: 'c.source', product_type: 'c.product_type' };
export function buildContactQuery(q) {
  const where = ['c.deleted_at is null', 'c.merged_into is null']; const vals = [];
  const p = v => { vals.push(v); return `$${vals.length}`; };
  if (q.q) {
    const s = String(q.q).trim();
    const lead = /^(lead\s*)?#?(\d{1,9})$/i.exec(s);
    const phone = normalizePhone(s);
    const parts = [`(coalesce(c.name,'') || ' ' || coalesce(c.company,'') || ' ' || coalesce(c.phone_e164,'') || ' ' || coalesce(c.email,'')) ilike ${p('%' + s.replace(/[%_]/g, '\\$&') + '%')}`];
    if (lead) parts.push(`c.lead_no = ${p(Number(lead[2]))}`);
    if (phone) parts.push(`c.phone_e164 = ${p(phone)}`);
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 4 && !phone) parts.push(`c.phone_e164 like ${p('%' + digits + '%')}`);
    where.push(`(${parts.join(' or ')})`);
  }
  const list = v => (Array.isArray(v) ? v : String(v).split(',')).filter(Boolean);
  if (q.status) where.push(`c.status = any(${p(list(q.status))})`);
  if (q.source) where.push(`c.source = any(${p(list(q.source))})`);
  if (q.product) where.push(`c.product_type = any(${p(list(q.product))})`);
  if (q.industry) where.push(`c.industry = any(${p(list(q.industry))})`);
  if (q.industry_type) where.push(`c.industry_type = any(${p(list(q.industry_type))})`);
  if (q.city) where.push(`c.city = any(${p(list(q.city))})`);
  if (q.county) where.push(`c.county = any(${p(list(q.county))})`);
  if (q.zip) where.push(`c.zip like ${p(String(q.zip).replace(/\D/g, '').slice(0, 5) + '%')}`);
  if (q.owner) where.push(q.owner === 'none' ? 'c.owner_user_id is null' : `c.owner_user_id = ${p(q.owner)}`);
  if (q.created_from) where.push(`c.created_at >= ${p(q.created_from)}`);
  if (q.created_to) where.push(`c.created_at < (${p(q.created_to)}::date + 1)`);
  if (q.activity_from) where.push(`c.last_activity_at >= ${p(q.activity_from)}`);
  if (q.activity_to) where.push(`c.last_activity_at < (${p(q.activity_to)}::date + 1)`);
  if (q.qty_min) where.push(`c.quantity >= ${p(Number(q.qty_min))}`);
  if (q.qty_max) where.push(`c.quantity <= ${p(Number(q.qty_max))}`);
  if (q.deadline_from) where.push(`c.deadline >= ${p(q.deadline_from)}`);
  if (q.deadline_to) where.push(`c.deadline <= ${p(q.deadline_to)}`);
  if (q.ids) where.push(`c.id = any(${p(list(q.ids))})`);
  const sortKey = SORTABLE[q.sort] ? q.sort : 'last_activity_at';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  return { where: where.join(' and '), vals, order: `${SORTABLE[sortKey]} ${dir} nulls last, c.lead_no desc` };
}

r.get('/', requirePerm('contacts.read'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1)); const size = Math.min(200, Math.max(10, Number(req.query.size || 50)));
  const { where, vals, order } = buildContactQuery(req.query);
  const out = await withBiz(req.ctx.businessId, async c => {
    const total = (await c.query(`select count(*)::int n from contacts c where ${where}`, vals)).rows[0].n;
    const rows = (await c.query(
      `select c.id, c.lead_no, c.name, c.company, c.phone_e164, c.email, c.socials, c.source, c.status, c.product_type, c.quantity, c.decoration,
              c.colors, c.sizes, c.deadline, c.industry, c.title, c.address, c.city, c.county, c.zip, c.license_no, c.business_type, c.industry_type, c.custom, c.created_at, c.last_activity_at, c.dnc, c.opted_out_at, c.sms_marketing,
              c.owner_user_id, u.name owner_name
         from contacts c left join users u on u.id = c.owner_user_id
        where ${where} order by ${order} limit ${size} offset ${(page - 1) * size}`, vals)).rows;
    return { total, rows };
  });
  res.json({ ...out, page, size, pages: Math.ceil(out.total / size) });
});

r.get('/facets', requirePerm('contacts.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => ({
    sources: (await c.query(`select distinct source from contacts where source is not null and deleted_at is null order by 1`)).rows.map(x => x.source),
    products: (await c.query(`select distinct product_type from contacts where product_type is not null and deleted_at is null order by 1`)).rows.map(x => x.product_type),
    users: (await c.query(`select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id where m.business_id = app_biz() and m.active and u.active order by u.name`)).rows,
    industries: (await c.query(`select distinct industry from contacts where industry is not null and deleted_at is null order by 1 limit 500`)).rows.map(x => x.industry),
    industryTypes: (await c.query(`select distinct industry_type from contacts where industry_type is not null and deleted_at is null order by 1 limit 500`)).rows.map(x => x.industry_type),
    cities: (await c.query(`select distinct city from contacts where city is not null and deleted_at is null order by 1 limit 2000`)).rows.map(x => x.city),
    counties: (await c.query(`select distinct county from contacts where county is not null and deleted_at is null order by 1 limit 500`)).rows.map(x => x.county),
    statuses: STATUSES,
    customFields: (await c.query(`select * from custom_fields where entity = 'contact' order by position, label`)).rows,
  }));
  res.json(out);
});

r.post('/', requirePerm('contacts.write'), async (req, res) => {
  const b = parse(contactInput, req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const { phone, ...rest } = b;
    const r2 = await createContact(c, req.ctx, { ...rest, phone_raw: phone || undefined, source: rest.source || 'manual', owner_user_id: rest.owner_user_id || req.ctx.userId });
    return r2;
  });
  res.status(out.existing ? 200 : 201).json(out);
});

r.get('/duplicates', requirePerm('contacts.read'), async (req, res) => {
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(
    `select d.*, row_to_json(a) a, row_to_json(b) b from duplicate_candidates d
       join (select id, lead_no, name, company, phone_e164, email, source, created_at from contacts) a on a.id = d.contact_a
       join (select id, lead_no, name, company, phone_e164, email, source, created_at from contacts) b on b.id = d.contact_b
      where d.status = 'pending' order by d.created_at desc limit 200`)).rows);
  res.json(rows);
});

r.post('/duplicates/:id/dismiss', requirePerm('contacts.merge'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    await c.query(`update duplicate_candidates set status = 'dismissed', resolved_by = $2, resolved_at = now() where id = $1`, [req.params.id, req.ctx.userId]);
    await audit(c, req.ctx, 'duplicate.dismiss', 'duplicate', req.params.id);
  });
  res.json({ ok: true });
});

r.post('/merge', requirePerm('contacts.merge'), async (req, res) => {
  const { into, from } = parse(z.object({ into: z.string().uuid(), from: z.string().uuid() }), req.body);
  const contact = await withBiz(req.ctx.businessId, c => mergeContacts(c, req.ctx, into, from));
  res.json(contact);
});

r.get('/export.csv', requirePerm('contacts.export'), async (req, res) => {
  const { where, vals, order } = buildContactQuery(req.query);
  const rows = await withBiz(req.ctx.businessId, async c => {
    await audit(c, req.ctx, 'contacts.export', 'contact', null, null, { filters: req.query });
    return (await c.query(`select c.lead_no, c.name, c.company, c.phone_e164 phone, c.email, c.source, c.status, c.product_type, c.quantity, c.decoration, c.colors, c.sizes,
      c.deadline, c.industry, c.title, c.address, c.city, c.county, c.zip, c.license_no, c.business_type, c.industry_type, c.other_personnel, c.employees, c.notes, c.sms_marketing, c.call_marketing, c.dnc, c.opted_out_at, c.created_at, c.last_activity_at, c.custom
      from contacts c where ${where} order by ${order}`, vals)).rows;
  });
  res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', `attachment; filename="ds-crm-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csvStringify(rows.map(x => ({ ...x, custom: JSON.stringify(x.custom) })), { header: true }));
});

// Import: preview first (no writes), then commit. Existing phones/emails update blanks only; no name-based merging.
r.post('/import', requirePerm('contacts.import'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose an Excel (.xlsx) or CSV file.');
  const rows = await readImportFile(req.file);
  if (!rows.length) throw badRequest('This file has no rows under the header.');
  const defaultSource = String(req.query.source || '').trim().slice(0, 60) || 'import';
  const commit = req.query.commit === '1';
  const map = row => ({ name: row.name || row.full_name || row.contact_name || row.licensee || row.licensee_name || row.owner || row.owner_name || null,
    company: row.company || row.company_name || row.business_name || row.business || row.organization || null,
    phone: row.phone || row.phone_number || row.mobile || row.business_phone || row.telephone || null, email: row.email || row.email_address || row.e_mail || null,
    source: row.source || defaultSource, product_type: row.product_type || row.product || null, quantity: row.quantity ? Number(row.quantity) : null,
    decoration: row.decoration || null, notes: row.notes || null, industry: row.industry || null,
    title: row.title || row.job_title || row.position || null, address: row.address || row.street || row.street_address || row.address_1 || row.address1 || null,
    city: row.city || null, county: row.county || null, zip: normZip(row.zip || row.zip_code || row.zipcode || row.postal_code),
    license_no: row.license || row.license_number || row.license_no || row.lic || null, business_type: row.business_type || row.entity_type || null,
    industry_type: row.industry_type || row.classification || null, other_personnel: row.other_personnel || null });
  const KNOWN = new Set(['n', 'no', 'name', 'full_name', 'contact_name', 'licensee', 'licensee_name', 'owner', 'owner_name', 'company', 'company_name', 'business_name', 'business', 'organization',
    'phone', 'phone_number', 'mobile', 'business_phone', 'telephone', 'email', 'email_address', 'e_mail', 'source', 'product_type', 'product', 'quantity', 'decoration', 'notes', 'industry',
    'title', 'job_title', 'position', 'address', 'street', 'street_address', 'address_1', 'address1', 'city', 'county', 'zip', 'zip_code', 'zipcode', 'postal_code',
    'license', 'license_number', 'license_no', 'lic', 'business_type', 'entity_type', 'industry_type', 'classification', 'other_personnel']);
  const headers = Object.keys(rows[0] || {}).filter(Boolean);
  const report = { total: rows.length, created: 0, updated: 0, invalid: [], duplicatesFlagged: 0, source: defaultSource,
    columns: { used: headers.filter(h => KNOWN.has(h) && !['n', 'no'].includes(h)), ignored: headers.filter(h => !KNOWN.has(h)) } };
  await withBiz(req.ctx.businessId, async c => {
    for (const [i, row] of rows.entries()) {
      const m = map(row);
      if (!m.name && !m.company && !m.phone) { report.invalid.push({ row: i + 2, reason: 'No name, company or phone' }); continue; }
      if (m.phone && !normalizePhone(m.phone)) { report.invalid.push({ row: i + 2, reason: `Invalid phone "${m.phone}"` }); continue; }
      if (!commit) {
        const hit = m.phone ? (await c.query(`select 1 from contact_identities where kind = 'phone' and value = $1`, [normalizePhone(m.phone)])).rowCount : 0;
        hit ? report.updated++ : report.created++;
        continue;
      }
      await c.query('savepoint imp');
      try {
        const { phone, ...rest } = m;
        const out = await createContact(c, req.ctx, { ...rest, phone_raw: phone || undefined });
        if (out.existing) {
          const patch = Object.fromEntries(Object.entries(rest).filter(([k, v]) => v && !out.contact[k] && k !== 'source'));
          if (Object.keys(patch).length) await updateContact(c, req.ctx, out.contact.id, patch);
          report.updated++;
        } else report.created++;
        await c.query('release savepoint imp');
      } catch (e) {
        await c.query('rollback to savepoint imp');
        report.invalid.push({ row: i + 2, reason: e.message });
      }
    }
    if (commit) {
      report.duplicatesFlagged = (await c.query(`select count(*)::int n from duplicate_candidates where status = 'pending' and created_at > now() - interval '5 minutes'`)).rows[0].n;
      await audit(c, req.ctx, 'contacts.import', 'contact', null, null, { created: report.created, updated: report.updated, invalid: report.invalid.length });
    }
  });
  res.json({ ...report, committed: commit });
});

r.get('/:id', requirePerm('contacts.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const contact = await getContact(c, req.params.id);
    const q = (sql, v = [contact.id]) => c.query(sql, v).then(x => x.rows);
    const seq = async fns => { const out = []; for (const f of fns) out.push(await f()); return out; }; // one connection: run in order
    const [timeline, conversations, quotes, orders, tasks, files, calls, identities, owner, dupes] = await seq([
      () => q(`select a.*, u.name actor_name from activities a left join users u on u.id = a.actor_user_id where a.contact_id = $1 order by a.created_at desc limit 300`),
      () => q(`select id, channel, status, ai_enabled, ai_paused_reason, needs_reply, last_message_at, last_inbound_at from conversations where contact_id = $1 order by last_message_at desc`),
      () => q(`select id, quote_no, status, total, created_at, valid_until from quotes where contact_id = $1 order by created_at desc`),
      () => q(`select id, order_no, status, payment_status, total, deadline from orders where contact_id = $1 order by created_at desc`),
      () => q(`select t.*, u.name assignee_name from tasks t left join users u on u.id = t.assignee_user_id where t.contact_id = $1 order by t.done_at nulls first, t.due_at nulls last`),
      () => q(`select id, kind, filename, mime, size, marketing_permission, created_at from files where contact_id = $1 order by created_at desc`),
      () => q(`select id, direction, status, handled_by, duration_sec, summary, outcome, next_action, created_at from calls where contact_id = $1 order by created_at desc limit 50`),
      () => q(`select kind, value, verified from contact_identities where contact_id = $1`),
      () => contact.owner_user_id ? q(`select id, name from users where id = $1`, [contact.owner_user_id]) : [],
      () => q(`select id, reason from duplicate_candidates where status = 'pending' and (contact_a = $1 or contact_b = $1)`),
    ]);
    const dncListed = contact.phone_e164 ? (await c.query('select 1 from dnc_numbers where phone_e164 = $1', [contact.phone_e164])).rowCount > 0 : false;
    return { contact: { ...contact, owner_name: owner[0]?.name || null, dnc_listed: dncListed }, timeline, conversations, quotes, orders, tasks, files, calls, identities, duplicates: dupes };
  });
  res.json(out);
});

r.patch('/:id', requirePerm('contacts.write'), async (req, res) => {
  const b = parse(contactInput.partial(), req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const before = await getContact(c, req.params.id);
    let after = await updateContact(c, req.ctx, req.params.id, b);
    if (b.sms_marketing === 'opted_in' && before.sms_marketing !== 'opted_in') {
      after = (await c.query(`update contacts set sms_consent_at = now(), sms_consent_source = $2, opted_out_at = null where id = $1 returning *`, [after.id, `recorded by ${req.ctx.name}`])).rows[0];
    }
    return after;
  });
  res.json(out);
});

r.delete('/:id', requirePerm('contacts.delete'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    const before = await getContact(c, req.params.id);
    await c.query(`update contacts set deleted_at = now() where id = $1`, [before.id]);
    await audit(c, req.ctx, 'contact.delete', 'contact', before.id, { lead_no: before.lead_no, name: before.name }, null);
  });
  res.json({ ok: true, undo: `/api/contacts/${req.params.id}/restore` });
});

r.post('/:id/restore', requirePerm('contacts.delete'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    const n = (await c.query(`update contacts set deleted_at = null where id = $1 returning id`, [req.params.id])).rowCount;
    if (!n) throw notFound();
    await audit(c, req.ctx, 'contact.restore', 'contact', req.params.id);
  });
  res.json({ ok: true });
});

r.post('/:id/intro-sms', requirePerm('inbox.reply'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const { sendIntroSms } = await import('../services/intro.js');
    const ct = await getContact(c, req.params.id);
    return sendIntroSms(c, req.ctx, ct, { reason: `staff:${Date.now()}`, purpose: 'marketing', author: 'user' });
  });
  if (out.skipped) throw badRequest(`Not sent: ${out.skipped}.`, { hint: out.skipped.includes('consent') ? 'Record the customer\'s agreement first (Marketing texts → Agreed).' : undefined });
  if (out.message.status === 'blocked') return res.status(422).json({ error: `Not sent: ${out.message.status_detail}`, message: out.message });
  res.status(201).json({ ok: true, conversationId: out.conversation.id, message: out.message });
});

r.post('/:id/phone-reply', requirePerm('inbox.reply'), async (req, res) => {
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(2000) }), req.body);
  const { logPhoneReply } = await import('./phonetexts.js');
  res.status(201).json(await withBiz(req.ctx.businessId, c => logPhoneReply(c, req.ctx, req.params.id, text)));
});

r.post('/:id/notes', requirePerm('contacts.write'), async (req, res) => {
  const { text } = parse(z.object({ text: z.string().min(1).max(5000) }), req.body);
  await withBiz(req.ctx.businessId, async c => {
    const ct = await getContact(c, req.params.id);
    await activity(c, req.ctx, ct.id, 'note', text);
  });
  res.status(201).json({ ok: true });
});

r.post('/:id/files', requirePerm('contacts.write'), upload.array('files', 10), async (req, res) => {
  const kind = ['logo', 'design', 'attachment', 'mockup'].includes(req.body.kind) ? req.body.kind : 'attachment';
  const files = req.files || [];
  if (!files.length) throw badRequest('Choose at least one file.');
  for (const f of files) if (!isAllowedMime(f.mimetype)) throw badRequest(`"${f.originalname}" is not an allowed file type.`, { hint: 'Use PNG, JPG, PDF, AI/EPS, SVG, PSD or ZIP.' });
  const out = await withBiz(req.ctx.businessId, async c => {
    const ct = await getContact(c, req.params.id);
    const saved = [];
    for (const f of files) {
      const key = saveBuffer(req.ctx.businessId, f.buffer, f.originalname);
      saved.push((await c.query(`insert into files (business_id, contact_id, kind, filename, mime, size, storage_key, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, kind, filename, mime, size`,
        [req.ctx.businessId, ct.id, kind, f.originalname, f.mimetype, f.size, key, req.ctx.userId])).rows[0]);
    }
    await activity(c, req.ctx, ct.id, 'file', `Uploaded ${saved.length} ${kind} file(s): ${saved.map(s => s.filename).join(', ')}`);
    return saved;
  });
  res.status(201).json(out);
});

export default r;
export { flagPossibleDuplicates };
