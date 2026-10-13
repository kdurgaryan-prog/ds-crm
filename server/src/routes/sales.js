import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, notFound, badRequest, conflict } from '../lib/http.js';
import { createQuote, setItems, transitionQuote, orderFromQuote, aiDraftQuote, computeTotals, ORDER_FLOW } from '../services/sales.js';
import { activity, audit } from '../services/audit.js';
import { saveBuffer, isAllowedMime, MAX_UPLOAD } from '../services/files.js';
import { getSettings } from '../services/settings.js';

export const quotes = Router();
export const orders = Router();
export const priceList = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

const item = z.object({ sku: z.string().optional(), description: z.string().max(300).optional(), product_type: z.string().max(80).optional(), decoration: z.string().max(60).optional(),
  color: z.string().max(80).nullish(), sizes: z.string().max(200).nullish(), qty: z.coerce.number().int().min(1), unit_price: z.coerce.number().min(0).optional() });

// ---------- price list ----------
priceList.get('/', requirePerm('quotes.read'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, async c => (await c.query(`select p.*, u.name approved_by_name from price_list p left join users u on u.id = p.approved_by order by product_type, decoration, sku, min_qty`)).rows));
});
priceList.post('/', requirePerm('pricelist.write'), async (req, res) => {
  const b = parse(z.object({ sku: z.string().min(1).max(40), name: z.string().min(1).max(120), product_type: z.string().min(1).max(80), decoration: z.string().min(1).max(60),
    min_qty: z.coerce.number().int().min(1).default(1), unit_price: z.coerce.number().min(0), approve: z.boolean().default(true) }), req.body);
  const row = await withBiz(req.ctx.businessId, async c => {
    const r = (await c.query(`insert into price_list (business_id, sku, name, product_type, decoration, min_qty, unit_price, approved_by, approved_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, case when $9 then now() end)
      on conflict (business_id, sku, min_qty) do update set name = excluded.name, product_type = excluded.product_type, decoration = excluded.decoration,
        unit_price = excluded.unit_price, approved_by = excluded.approved_by, approved_at = excluded.approved_at, active = true returning *`,
      [req.ctx.businessId, b.sku, b.name, b.product_type, b.decoration, b.min_qty, b.unit_price, b.approve ? req.ctx.userId : null, b.approve])).rows[0];
    await audit(c, req.ctx, 'pricelist.upsert', 'price_list', r.id, null, b);
    return r;
  });
  res.status(201).json(row);
});
priceList.delete('/:id', requirePerm('pricelist.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => { await c.query('update price_list set active = false where id = $1', [req.params.id]); await audit(c, req.ctx, 'pricelist.deactivate', 'price_list', req.params.id); });
  res.json({ ok: true });
});

// ---------- quotes ----------
quotes.get('/', requirePerm('quotes.read'), async (req, res) => {
  const { status } = req.query;
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(
    `select q.*, c.name contact_name, c.company, c.lead_no, (select id from orders o where o.quote_id = q.id) order_id
       from quotes q join contacts c on c.id = q.contact_id ${status ? 'where q.status = any($1)' : ''} order by q.created_at desc limit 500`, status ? [String(status).split(',')] : [])).rows);
  res.json(rows);
});

quotes.post('/', requirePerm('quotes.write'), async (req, res) => {
  const b = parse(z.object({ contactId: z.string().uuid(), items: z.array(item).default([]), tax_rate: z.coerce.number().min(0).max(0.5).optional(), shipping: z.coerce.number().min(0).default(0),
    production_days: z.coerce.number().int().min(0).nullish(), due_date: z.string().nullish(), notes: z.string().max(4000).nullish() }), req.body);
  const q = await withBiz(req.ctx.businessId, c => createQuote(c, req.ctx, b));
  res.status(201).json(q);
});

quotes.post('/ai-draft', requirePerm('quotes.write'), async (req, res) => {
  const { contactId } = parse(z.object({ contactId: z.string().uuid() }), req.body);
  const q = await withBiz(req.ctx.businessId, c => aiDraftQuote(c, req.ctx, contactId));
  res.status(201).json(q);
});

quotes.get('/:id', requirePerm('quotes.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const q = (await c.query(`select q.*, c.name contact_name, c.company, c.phone_e164, c.email, c.lead_no, u.name approved_by_name,
        (select id from orders o where o.quote_id = q.id) order_id from quotes q join contacts c on c.id = q.contact_id left join users u on u.id = q.approved_by where q.id = $1`, [req.params.id])).rows[0];
    if (!q) throw notFound('Quote not found.');
    const items = (await c.query('select * from quote_items where quote_id = $1 order by position', [q.id])).rows;
    return { ...q, items };
  });
  res.json(out);
});

quotes.patch('/:id', requirePerm('quotes.write'), async (req, res) => {
  const b = parse(z.object({ items: z.array(item).optional(), tax_rate: z.coerce.number().min(0).max(0.5).optional(), shipping: z.coerce.number().min(0).optional(),
    production_days: z.coerce.number().int().min(0).nullish(), due_date: z.string().nullish(), notes: z.string().max(4000).nullish() }), req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const q = (await c.query('select * from quotes where id = $1', [req.params.id])).rows[0];
    if (!q) throw notFound('Quote not found.');
    if (!['draft', 'pending_approval'].includes(q.status)) throw conflict('Approved or sent quotes cannot be edited.');
    await c.query(`update quotes set tax_rate = coalesce($2, tax_rate), shipping = coalesce($3, shipping), production_days = coalesce($4, production_days),
                    due_date = coalesce($5::date, due_date), notes = coalesce($6, notes), status = 'draft', updated_at = now() where id = $1`,
      [q.id, b.tax_rate ?? null, b.shipping ?? null, b.production_days ?? null, b.due_date || null, b.notes ?? null]);
    if (b.items) await setItems(c, req.ctx, q.id, b.items); else await computeTotals(c, q.id);
    await audit(c, req.ctx, 'quote.update', 'quote', q.id);
    return (await c.query('select * from quotes where id = $1', [q.id])).rows[0];
  });
  res.json(out);
});

quotes.post('/:id/order', requirePerm('orders.write'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, c => orderFromQuote(c, req.ctx, req.params.id));
  res.status(out.existing ? 200 : 201).json(out);
});

quotes.post('/:id/:action', requirePerm('quotes.write'), async (req, res) => {
  if (!['submit', 'approve', 'mark_sent', 'accept', 'decline', 'reopen'].includes(req.params.action)) throw notFound();
  res.json(await withBiz(req.ctx.businessId, c => transitionQuote(c, req.ctx, req.params.id, req.params.action)));
});

// Printable quote (Save as PDF from the browser)
quotes.get('/:id/print', requirePerm('quotes.read'), async (req, res) => {
  const { q, items, s } = await withBiz(req.ctx.businessId, async c => {
    const q = (await c.query(`select q.*, c.name, c.company, c.phone_e164, c.email from quotes q join contacts c on c.id = q.contact_id where q.id = $1`, [req.params.id])).rows[0];
    if (!q) throw notFound();
    return { q, items: (await c.query('select * from quote_items where quote_id = $1 order by position', [q.id])).rows, s: await getSettings(c, req.ctx.businessId) };
  });
  const esc = v => String(v ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const money = n => '$' + Number(n).toFixed(2);
  const draft = !['approved', 'sent', 'accepted'].includes(q.status);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Quote Q-${q.quote_no}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:780px;margin:32px auto;padding:0 16px;color:#1d2433}h1{margin:0}table{width:100%;border-collapse:collapse;margin:20px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}td.n,th.n{text-align:right}.muted{color:#667}.wm{color:#b42318;font-weight:700;border:2px solid #b42318;padding:4px 10px;display:inline-block}@media print{.np{display:none}}</style>
<p class="np"><button onclick="print()">Print / Save as PDF</button></p>
${draft ? '<p class="wm">DRAFT — NOT APPROVED. Do not send.</p>' : ''}
<h1>${esc(s.company.legalName)}</h1><p class="muted">${esc(s.company.website)}</p>
<h2>Quote Q-${q.quote_no}</h2><p>For: <b>${esc(q.name)}</b>${q.company ? `, ${esc(q.company)}` : ''}<br>Date: ${new Date(q.created_at).toLocaleDateString('en-US')} · Valid until: ${esc(q.valid_until)}${q.due_date ? ` · Needed by: ${esc(q.due_date)}` : ''}${q.production_days ? ` · Production: ${q.production_days} business days after approval` : ''}</p>
<table><tr><th>Item</th><th>Decoration</th><th>Color / sizes</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Total</th></tr>
${items.map(i => `<tr><td>${esc(i.description)}</td><td>${esc(i.decoration)}</td><td>${esc([i.color, i.sizes].filter(Boolean).join(' · '))}</td><td class="n">${i.qty}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.line_total)}</td></tr>`).join('')}
<tr><td colspan="5" class="n">Subtotal</td><td class="n">${money(q.subtotal)}</td></tr><tr><td colspan="5" class="n">Tax (${(q.tax_rate * 100).toFixed(2)}%)</td><td class="n">${money(q.tax)}</td></tr>
<tr><td colspan="5" class="n">Shipping</td><td class="n">${money(q.shipping)}</td></tr><tr><th colspan="5" class="n">Total</th><th class="n">${money(q.total)}</th></tr></table>
${q.notes && !q.created_by_agent ? `<p>${esc(q.notes)}</p>` : ''}`);
});

// ---------- orders ----------
orders.get('/', requirePerm('orders.read'), async (req, res) => {
  const { status, due } = req.query;
  const where = []; const vals = [];
  if (status) { vals.push(String(status).split(',')); where.push(`o.status = any($${vals.length})`); }
  else where.push(`o.status not in ('Delivered','Canceled')`);
  if (due === 'week') where.push(`o.deadline <= current_date + 7`);
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(
    `select o.*, c.name contact_name, c.company, c.lead_no, (select count(*) from design_versions d where d.order_id = o.id)::int designs,
            (select max(customer_approved_at) from design_versions d where d.order_id = o.id) design_approved_at
       from orders o join contacts c on c.id = o.contact_id where ${where.join(' and ')} order by o.deadline nulls last, o.created_at desc limit 500`, vals)).rows);
  res.json({ rows, flow: ORDER_FLOW });
});

orders.get('/:id', requirePerm('orders.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const o = (await c.query(`select o.*, c.name contact_name, c.company, c.lead_no, c.phone_e164, q.quote_no from orders o join contacts c on c.id = o.contact_id left join quotes q on q.id = o.quote_id where o.id = $1`, [req.params.id])).rows[0];
    if (!o) throw notFound('Order not found.');
    return {
      ...o, flow: ORDER_FLOW,
      items: (await c.query('select * from order_items where order_id = $1 order by position', [o.id])).rows,
      designs: (await c.query(`select d.*, f.filename, f.mime from design_versions d left join files f on f.id = d.file_id where d.order_id = $1 order by version desc`, [o.id])).rows,
      files: (await c.query(`select id, kind, filename, mime from files where order_id = $1 or (contact_id = $2 and kind in ('logo','design'))`, [o.id, o.contact_id])).rows,
      tasks: (await c.query(`select * from tasks where order_id = $1 order by done_at nulls first, due_at`, [o.id])).rows,
    };
  });
  res.json(out);
});

orders.patch('/:id', requirePerm('orders.write'), async (req, res) => {
  const b = parse(z.object({ status: z.enum([...ORDER_FLOW, 'Canceled']).optional(), payment_status: z.enum(['unpaid', 'deposit', 'paid', 'refunded']).optional(),
    amount_paid: z.coerce.number().min(0).optional(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), production_notes: z.string().max(10000).nullish() }), req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const o = (await c.query('select * from orders where id = $1 for update', [req.params.id])).rows[0];
    if (!o) throw notFound('Order not found.');
    if (b.status === 'In Production') {
      const approved = (await c.query('select 1 from design_versions where order_id = $1 and customer_approved_at is not null', [o.id])).rowCount;
      if (!approved && !req.body.override) throw conflict('The customer has not approved a design yet.', { hint: 'Record the design approval first, or confirm to override.', code: 'design_not_approved' });
    }
    const after = (await c.query(`update orders set status = coalesce($2, status), payment_status = coalesce($3, payment_status), amount_paid = coalesce($4, amount_paid),
        deadline = case when $5::boolean then $6::date else deadline end, production_notes = coalesce($7, production_notes), updated_at = now() where id = $1 returning *`,
      [o.id, b.status ?? null, b.payment_status ?? null, b.amount_paid ?? null, b.deadline !== undefined, b.deadline || null, b.production_notes ?? null])).rows[0];
    if (b.status && b.status !== o.status) await activity(c, req.ctx, o.contact_id, 'order', `Order #${o.order_no}: ${o.status} → ${b.status}`, { refId: o.id });
    if (b.payment_status && b.payment_status !== o.payment_status) await activity(c, req.ctx, o.contact_id, 'order', `Order #${o.order_no} payment: ${b.payment_status}`, { refId: o.id });
    await audit(c, req.ctx, 'order.update', 'order', o.id, { status: o.status, payment_status: o.payment_status }, b);
    return after;
  });
  res.json(out);
});

orders.post('/:id/designs', requirePerm('orders.write'), upload.single('file'), async (req, res) => {
  if (req.file && !isAllowedMime(req.file.mimetype)) throw badRequest('That file type is not allowed.');
  const out = await withBiz(req.ctx.businessId, async c => {
    const o = (await c.query('select * from orders where id = $1', [req.params.id])).rows[0];
    if (!o) throw notFound();
    let fileId = null;
    if (req.file) {
      const key = saveBuffer(req.ctx.businessId, req.file.buffer, req.file.originalname);
      fileId = (await c.query(`insert into files (business_id, contact_id, order_id, kind, filename, mime, size, storage_key, uploaded_by) values ($1,$2,$3,'mockup',$4,$5,$6,$7,$8) returning id`,
        [req.ctx.businessId, o.contact_id, o.id, req.file.originalname, req.file.mimetype, req.file.size, key, req.ctx.userId])).rows[0].id;
    }
    const v = (await c.query('select coalesce(max(version),0)+1 v from design_versions where order_id = $1', [o.id])).rows[0].v;
    const d = (await c.query(`insert into design_versions (business_id, order_id, version, file_id, notes, created_by) values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.ctx.businessId, o.id, v, fileId, req.body.notes || null, req.ctx.userId])).rows[0];
    if (o.status === 'New' || o.status === 'Awaiting Artwork') await c.query(`update orders set status = 'Awaiting Approval' where id = $1`, [o.id]);
    await activity(c, req.ctx, o.contact_id, 'order', `Design v${v} added to order #${o.order_no}`, { refId: o.id });
    return d;
  });
  res.status(201).json(out);
});

orders.post('/:id/designs/:did/approve', requirePerm('orders.write'), async (req, res) => {
  const { note } = parse(z.object({ note: z.string().min(3, 'Say how the customer approved (e.g. "SMS: looks good")').max(300) }), req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const d = (await c.query(`update design_versions set customer_approved_at = now(), approval_note = $3 where id = $1 and order_id = $2 returning *`, [req.params.did, req.params.id, note])).rows[0];
    if (!d) throw notFound();
    const o = (await c.query(`update orders set status = case when status in ('New','Awaiting Artwork','Awaiting Approval') then (case when payment_status = 'paid' then 'In Production' else 'Awaiting Payment' end) else status end where id = $1 returning *`, [req.params.id])).rows[0];
    await activity(c, req.ctx, o.contact_id, 'order', `Customer approved design v${d.version} (${note})`, { refId: o.id });
    await audit(c, req.ctx, 'design.approve', 'order', o.id, null, { version: d.version, note });
    return d;
  });
  res.json(out);
});
