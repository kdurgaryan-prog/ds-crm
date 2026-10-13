// Quotes and orders.
import { nextNumber } from '../db.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/http.js';
import { activity, audit, logAgentAction } from './audit.js';
import { getContact } from './contacts.js';
import { getSettings } from './settings.js';
import { can } from '../lib/permissions.js';

const round2 = n => Math.round(n * 100) / 100;

/** Best approved tier for an item at a quantity: highest min_qty ≤ qty. */
export async function priceFor(c, { sku, qty }) {
  return (await c.query(`select * from price_list where sku = $1 and active and approved_at is not null and min_qty <= $2 order by min_qty desc limit 1`, [sku, qty])).rows[0] || null;
}

export async function computeTotals(c, quoteId) {
  const q = (await c.query('select * from quotes where id = $1', [quoteId])).rows[0];
  const items = (await c.query('select * from quote_items where quote_id = $1 order by position', [quoteId])).rows;
  const subtotal = round2(items.reduce((s, i) => s + Number(i.line_total), 0));
  const tax = round2(subtotal * Number(q.tax_rate));
  const total = round2(subtotal + tax + Number(q.shipping));
  await c.query('update quotes set subtotal = $2, tax = $3, total = $4, updated_at = now() where id = $1', [quoteId, subtotal, tax, total]);
  return { subtotal, tax, total, items };
}

/** Replace the quote's items. Price-list items use the approved price; custom prices need quotes.approve or keep the quote unapproved. */
export async function setItems(c, ctx, quoteId, items) {
  const q = (await c.query('select * from quotes where id = $1', [quoteId])).rows[0];
  if (!q) throw notFound('Quote not found.');
  if (!['draft', 'pending_approval'].includes(q.status)) throw conflict('Approved or sent quotes cannot be edited.', { hint: 'Create a new revision instead.' });
  await c.query('delete from quote_items where quote_id = $1', [quoteId]);
  let pos = 0;
  for (const it of items) {
    if (!(it.qty > 0)) throw badRequest('Each line needs a quantity.');
    let unit = it.unit_price; let priceItemId = null; let desc = it.description;
    if (it.sku) {
      const tier = await priceFor(c, { sku: it.sku, qty: it.qty });
      if (!tier) throw badRequest(`No approved price for ${it.sku} at quantity ${it.qty}.`, { hint: 'Add or approve a price-list tier, or enter a custom price.' });
      unit = Number(tier.unit_price); priceItemId = tier.id; desc ||= tier.name;
    } else if (unit === undefined || unit === null) throw badRequest('Custom lines need a unit price.');
    await c.query(`insert into quote_items (business_id, quote_id, price_item_id, description, product_type, decoration, color, sizes, qty, unit_price, line_total, position)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.businessId, quoteId, priceItemId, desc || 'Item', it.product_type || null, it.decoration || null, it.color || null, it.sizes || null, it.qty, unit, round2(unit * it.qty), pos++]);
  }
  if (q.status === 'pending_approval') await c.query(`update quotes set status = 'draft' where id = $1`, [quoteId]);
  return computeTotals(c, quoteId);
}

export async function createQuote(c, ctx, { contactId, items = [], tax_rate, shipping = 0, production_days = null, due_date = null, notes = null, agent = null }) {
  const contact = await getContact(c, contactId);
  const s = await getSettings(c, ctx.businessId);
  const no = await nextNumber(c, ctx.businessId, 'quote');
  const validUntil = new Date(Date.now() + s.quotes.validDays * 86400_000).toISOString().slice(0, 10);
  const q = (await c.query(`insert into quotes (business_id, quote_no, contact_id, tax_rate, shipping, production_days, due_date, valid_until, notes, created_by, created_by_agent)
                            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [ctx.businessId, no, contact.id, tax_rate ?? s.quotes.defaultTaxRate, shipping, production_days, due_date || contact.deadline, validUntil, notes, ctx.userId || null, agent])).rows[0];
  if (items.length) await setItems(c, ctx, q.id, items);
  await activity(c, ctx, contact.id, 'quote', `Quote Q-${no} drafted${agent ? ` by ${agent}` : ''}`, { refId: q.id });
  await audit(c, ctx, 'quote.create', 'quote', q.id, null, { quote_no: no });
  return (await c.query('select * from quotes where id = $1', [q.id])).rows[0];
}

/** AI draft: match the customer's requirements to the approved price list. Nothing else is invented. */
export async function aiDraftQuote(c, ctx, contactId) {
  const contact = await getContact(c, contactId);
  const missing = ['product_type', 'quantity', 'decoration'].filter(f => !contact[f]);
  if (missing.length) {
    await logAgentAction(c, ctx.businessId, { agent: 'natalie', action: 'draft_quote', basedOn: { contactId }, result: 'skipped', detail: `Missing: ${missing.join(', ')}` });
    throw badRequest(`Cannot draft yet — missing ${missing.join(', ').replace(/_/g, ' ')}.`, { hint: 'Fill these on the customer card first.' });
  }
  const match = (await c.query(
    `select * from price_list where active and approved_at is not null and lower(product_type) = lower($1) and lower(decoration) = lower($2) and min_qty <= $3
      order by min_qty desc limit 1`, [contact.product_type, contact.decoration, contact.quantity])).rows[0];
  if (!match) {
    await logAgentAction(c, ctx.businessId, { agent: 'natalie', action: 'draft_quote', basedOn: { contactId, product_type: contact.product_type, decoration: contact.decoration, quantity: contact.quantity }, result: 'skipped', detail: 'No approved price-list match' });
    throw badRequest(`No approved price for ${contact.product_type} with ${contact.decoration} at ${contact.quantity} pcs.`, { hint: 'Add it to the price list (Quotes → Price list), or build the quote manually.' });
  }
  const q = await createQuote(c, { ...ctx, agent: 'natalie' }, {
    contactId, agent: 'natalie',
    items: [{ sku: match.sku, qty: contact.quantity, description: match.name, product_type: match.product_type, decoration: match.decoration, color: contact.colors, sizes: contact.sizes }],
    notes: 'Draft prepared from the approved price list. Needs review and approval before sending.',
  });
  await logAgentAction(c, ctx.businessId, { agent: 'natalie', action: 'draft_quote', basedOn: { contactId, priceItem: match.sku, tierMinQty: match.min_qty }, change: { quoteId: q.id }, approvalRequired: true, approvalStatus: 'pending', result: 'ok' });
  return q;
}

export async function transitionQuote(c, ctx, id, action) {
  const q = (await c.query('select * from quotes where id = $1 for update', [id])).rows[0];
  if (!q) throw notFound('Quote not found.');
  const items = (await c.query('select count(*)::int n from quote_items where quote_id = $1', [id])).rows[0].n;
  const go = async (to, extra = '') => (await c.query(`update quotes set status = $2${extra}, updated_at = now() where id = $1 returning *`, [id, to])).rows[0];
  let out;
  if (action === 'submit') { if (q.status !== 'draft') throw conflict('Only drafts can be submitted.'); if (!items) throw badRequest('Add at least one item.'); out = await go('pending_approval'); }
  else if (action === 'approve') {
    if (!can(ctx.role, 'quotes.approve')) throw forbidden('Only an owner or admin can approve final prices.');
    if (!['draft', 'pending_approval'].includes(q.status)) throw conflict(`Quote is ${q.status}.`);
    if (!items) throw badRequest('Add at least one item.');
    out = (await c.query(`update quotes set status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() where id = $1 returning *`, [id, ctx.userId])).rows[0];
    if (q.created_by_agent) await logAgentAction(c, ctx.businessId, { agent: q.created_by_agent, action: 'quote_approved', basedOn: { quoteId: id }, approvalRequired: true, approvalStatus: 'approved', result: 'ok' });
  } else if (action === 'mark_sent') {
    if (q.status !== 'approved') throw conflict('A quote must be approved before it is sent to the customer.');
    out = await go('sent', ', sent_at = now()');
    await c.query(`update contacts set status = 'Quote Sent' where id = $1 and status not in ('Won','Lost')`, [q.contact_id]);
  } else if (action === 'accept') { if (!['approved', 'sent'].includes(q.status)) throw conflict('Only approved or sent quotes can be accepted.'); out = await go('accepted'); }
  else if (action === 'decline') { if (!['approved', 'sent'].includes(q.status)) throw conflict('Only approved or sent quotes can be declined.'); out = await go('declined'); }
  else if (action === 'reopen') { if (!['declined', 'pending_approval', 'approved'].includes(q.status)) throw conflict('This quote cannot be reopened.'); out = (await c.query(`update quotes set status = 'draft', approved_by = null, approved_at = null where id = $1 returning *`, [id])).rows[0]; }
  else throw badRequest('Unknown action.');
  await activity(c, ctx, q.contact_id, 'quote', `Quote Q-${q.quote_no}: ${q.status} → ${out.status}`, { refId: id });
  await audit(c, ctx, `quote.${action}`, 'quote', id, { status: q.status }, { status: out.status });
  return out;
}

/** Create the order from an accepted/approved/sent quote, copying everything (no re-typing). Idempotent per quote. */
export async function orderFromQuote(c, ctx, quoteId) {
  const q = (await c.query('select * from quotes where id = $1 for update', [quoteId])).rows[0];
  if (!q) throw notFound('Quote not found.');
  const existing = (await c.query('select * from orders where quote_id = $1', [quoteId])).rows[0];
  if (existing) return { order: existing, existing: true };
  if (!['approved', 'sent', 'accepted'].includes(q.status)) throw conflict('Only approved quotes can become orders.', { hint: 'Approve the quote first.' });
  const no = await nextNumber(c, ctx.businessId, 'order');
  const contact = await getContact(c, q.contact_id);
  const order = (await c.query(`insert into orders (business_id, order_no, contact_id, quote_id, status, total, deadline, owner_user_id, created_by)
                                values ($1,$2,$3,$4,'New',$5,$6,$7,$8) returning *`,
    [ctx.businessId, no, q.contact_id, q.id, q.total, q.due_date || contact.deadline, contact.owner_user_id, ctx.userId || null])).rows[0];
  await c.query(`insert into order_items (business_id, order_id, description, product_type, decoration, color, sizes, qty, unit_price, line_total, position)
                 select business_id, $2, description, product_type, decoration, color, sizes, qty, unit_price, line_total, position from quote_items where quote_id = $1`, [q.id, order.id]);
  if (q.status !== 'accepted') await c.query(`update quotes set status = 'accepted', updated_at = now() where id = $1`, [q.id]);
  await c.query(`update contacts set status = 'Won' where id = $1`, [q.contact_id]);
  await c.query(`update files set order_id = $2 where contact_id = $1 and kind in ('logo','design') and order_id is null`, [q.contact_id, order.id]);
  await activity(c, ctx, q.contact_id, 'order', `Order #${no} created from quote Q-${q.quote_no}`, { refId: order.id });
  await audit(c, ctx, 'order.create', 'order', order.id, null, { order_no: no, quote: q.quote_no });
  return { order, existing: false };
}

export const ORDER_FLOW = ['New', 'Awaiting Artwork', 'Awaiting Approval', 'Awaiting Payment', 'In Production', 'Quality Check', 'Ready', 'Delivered'];
