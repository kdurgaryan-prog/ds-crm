// Public endpoints for the DS Systems website (Shopify): chat widget and quote/contact form.
// Locked to the business' public key, allowed site origins, rate limits and a honeypot field.
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withSystem, withBiz } from '../db.js';
import { config } from '../config.js';
import { parse, AppError } from '../lib/http.js';
import { handleInbound } from '../services/messaging.js';
import { createContact, updateContact } from '../services/contacts.js';
import { normalizePhone } from '../services/compliance.js';
import { activity } from '../services/audit.js';
import { getSettings } from '../services/settings.js';

const router = Router();
router.use(express.json({ limit: '64kb' }));

router.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.allowedSiteOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  } else if (origin && config.appEnv === 'production') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now(); const h = hits.get(key) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; hits.set(key, h);
  if (hits.size > 50_000) hits.clear();
  return h.n <= max;
}

async function businessByKey(key) {
  const id = await withSystem(async c => (await c.query('select id from businesses where public_key = $1', [key])).rows[0]?.id);
  if (!id) throw new AppError(404, 'Unknown site key');
  return id;
}

function visitorSig(businessId, visitorId) {
  return crypto.createHmac('sha256', crypto.createHash('sha256').update('webchat:' + (config.encryptionKey || 'dev')).digest()).update(`${businessId}:${visitorId}`).digest('base64url').slice(0, 32);
}

// ---------- website chat ----------
router.post('/:key/chat/session', async (req, res) => {
  const businessId = await businessByKey(req.params.key);
  if (!limit(`sess:${req.ip}`, 30, 3600_000)) throw new AppError(429, 'Too many requests');
  const visitorId = 'v_' + crypto.randomBytes(12).toString('base64url');
  const s = await withBiz(businessId, getSettingsFor(businessId));
  res.json({ visitorId, token: visitorSig(businessId, visitorId), agentName: s.agents.natalie.displayName, greeting: `Hi! I'm ${s.agents.natalie.displayName}, DS Systems' AI assistant. What can we make for your team?` });
});
const getSettingsFor = id => c => getSettings(c, id);

const chatMsg = z.object({ visitorId: z.string().min(5).max(40), token: z.string().min(10), text: z.string().min(1).max(2000), name: z.string().max(120).optional(), phone: z.string().max(40).optional(), website: z.string().max(0).optional() });

router.post('/:key/chat/messages', async (req, res) => {
  const businessId = await businessByKey(req.params.key);
  const b = parse(chatMsg, req.body);
  if (b.token !== visitorSig(businessId, b.visitorId)) throw new AppError(403, 'Invalid chat session');
  if (!limit(`chat:${b.visitorId}`, 40, 600_000) || !limit(`chatip:${req.ip}`, 120, 600_000)) throw new AppError(429, 'Please slow down a little.');
  const out = await withBiz(businessId, async c => {
    // A phone typed into chat is unverified: it must never link this visitor to an existing customer.
    const phone = b.phone ? normalizePhone(b.phone) : null;
    const r = await handleInbound(c, { businessId }, { channel: 'webchat', thread: b.visitorId, phone: null, name: b.name || null, body: b.text, providerId: `wc_${crypto.randomUUID()}`, source: 'webchat' });
    if (phone && r.contact && !r.contact.phone_e164 && !(r.contact.notes || '').includes(phone)) {
      await c.query(`update contacts set notes = concat_ws(E'\n', notes, $2::text) where id = $1`, [r.contact.id, `Phone typed in website chat (not verified): ${phone}`]);
      const other = (await c.query(`select contact_id from contact_identities where kind = 'phone' and value = $1`, [phone])).rows[0];
      if (other) {
        const [x, y] = [r.contact.id, other.contact_id].sort();
        await c.query(`insert into duplicate_candidates (business_id, contact_a, contact_b, reason) values ($1,$2,$3,'Website chat visitor typed a phone number that belongs to this customer — confirm before merging') on conflict do nothing`, [businessId, x, y]);
      }
    }
    await c.query(`update channel_accounts set status = 'connected', last_error = null, last_checked_at = now() where channel = 'webchat'`);
    await c.query(`insert into channel_accounts (business_id, channel, status, last_checked_at) values ($1,'webchat','connected',now()) on conflict do nothing`, [businessId]);
    return { id: r.message?.id };
  });
  res.json({ ok: true, ...out });
});

router.get('/:key/chat/messages', async (req, res) => {
  const businessId = await businessByKey(req.params.key);
  const { visitorId, token, after } = req.query;
  if (!visitorId || token !== visitorSig(businessId, String(visitorId))) throw new AppError(403, 'Invalid chat session');
  const rows = await withBiz(businessId, async c => (await c.query(
    `select m.id, m.direction, m.body, m.author_type, m.created_at from messages m join conversations cv on cv.id = m.conversation_id
      where cv.channel = 'webchat' and cv.external_thread_id = $1 and m.status not in ('blocked','failed','queued','sending')
        and ($2::timestamptz is null or m.created_at > $2) order by m.created_at limit 100`, [visitorId, after || null])).rows);
  res.json({ messages: rows });
});

// ---------- quote / contact form ----------
const form = z.object({
  name: z.string().min(1).max(120), company: z.string().max(160).optional(), phone: z.string().min(7).max(40),
  email: z.string().email().max(200).optional().or(z.literal('')),
  product_type: z.string().max(80).optional(), quantity: z.coerce.number().int().min(1).max(100000).optional(),
  decoration: z.string().max(40).optional(), colors: z.string().max(200).optional(), sizes: z.string().max(200).optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), message: z.string().max(4000).optional(),
  sms_consent: z.coerce.boolean().optional(), form: z.enum(['quote', 'contact']).default('quote'),
  website: z.string().max(0).optional(), // honeypot: must stay empty
});

/** One website request → customer (new or existing by phone), Inbox thread, timeline entry and follow-up task. */
async function ingestWebsiteRequest(businessId, f, { details = [], via = 'CRM form' } = {}) {
  const phone = normalizePhone(f.phone);
  if (!phone) throw new AppError(400, 'Please enter a valid phone number.', { details: [{ field: 'phone', message: 'Invalid phone number' }] });
  return withBiz(businessId, async c => {
    const ctx = { businessId };
    const fields = { name: f.name, company: f.company || null, product_type: f.product_type || null, quantity: f.quantity ?? null, decoration: f.decoration || null, colors: f.colors || null, sizes: f.sizes || null, deadline: f.deadline || null };
    // email is stored only because the customer typed it into the quote form themselves
    const r = await createContact(c, ctx, { ...fields, phone_raw: phone, email: f.email || null, source: f.form === 'quote' ? 'website_quote' : 'website_contact', sms_marketing: f.sms_consent ? 'opted_in' : 'unknown' });
    let contact = r.contact;
    if (r.existing) {
      const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== null && v !== '' && (contact[k] === null || contact[k] === '')));
      if (f.sms_consent && contact.sms_marketing !== 'opted_out') patch.sms_marketing = 'opted_in';
      if (f.email && !contact.email) patch.email = f.email;
      if (Object.keys(patch).length) contact = await updateContact(c, ctx, contact.id, patch);
    }
    const head = [f.product_type, f.quantity && `${f.quantity} pcs`, f.decoration, f.deadline && `by ${f.deadline}`].filter(Boolean).join(', ') || 'general inquiry';
    const summary = `Website ${f.form} request: ${head}${f.message ? ` — "${f.message.slice(0, 200)}"` : ''}`;
    await activity(c, ctx, contact.id, 'message', summary, { data: { channel: 'website_forms', via, form: f, details } });
    // forms land in the Inbox too, as a thread the team can pick up (replies go out by SMS)
    const conv = (await c.query(`insert into conversations (business_id, contact_id, channel, external_thread_id, needs_reply, ai_enabled, last_inbound_at)
      values ($1,$2,'website_forms',$3,true,false, now()) on conflict (business_id, channel, external_thread_id) do update set needs_reply = true, status = 'open', last_message_at = now() returning id`,
      [businessId, contact.id, `form:${contact.id}`])).rows[0];
    const body = [summary, ...details, f.email ? `Email: ${f.email}` : null, f.message ? `Notes: ${f.message}` : null].filter(Boolean).join('\n');
    await c.query(`insert into messages (business_id, conversation_id, contact_id, direction, channel, body, author_type, status) values ($1,$2,$3,'in','website_forms',$4,'customer','received')`,
      [businessId, conv.id, contact.id, body]);
    await c.query(`insert into tasks (business_id, contact_id, title, kind, due_at) values ($1,$2,$3,'follow_up', now() + interval '2 hours')`,
      [businessId, contact.id, `Respond to website ${f.form} request`]);
    await c.query(`insert into channel_accounts (business_id, channel, status, last_checked_at) values ($1,'website_forms','connected',now())
                   on conflict (business_id, channel) do update set status = 'connected', last_error = null, last_checked_at = now()`, [businessId]);
    return { leadNo: contact.lead_no };
  });
}

router.post('/:key/forms', async (req, res) => {
  const businessId = await businessByKey(req.params.key);
  if (!limit(`form:${req.ip}`, 8, 3600_000)) throw new AppError(429, 'Too many submissions. Please call us instead.');
  const raw = typeof req.body === 'object' ? req.body : {};
  if (raw.website) return res.json({ ok: true }); // bot: pretend OK, store nothing
  const f = parse(form, raw);
  const result = await ingestWebsiteRequest(businessId, f);
  res.json({ ok: true, received: !!result.leadNo }); // no lead numbers exposed publicly
});

// ---------- the existing "Get a Quote" form on dssuniforms.com ----------
// The theme script (dss.js) sends a copy of every submission to the form's data-webhook URL with
// navigator.sendBeacon as text/plain JSON: keys are the Shopify field names without "contact[...]".
// Shopify keeps emailing the store as before, so nothing is lost if the CRM is briefly unreachable.
const DECOR = { 'DTF printing': 'DTF printing', Embroidery: 'Embroidery', 'Screen printing': 'Screen printing', 'Not sure yet': 'Not sure', 'Not sure': 'Not sure' };
export function mapShopifyQuote(d) {
  const str = v => (v === undefined || v === null ? '' : String(v)).trim();
  const picked = prefix => Object.keys(d).filter(k => k.startsWith(prefix) && /^(yes|on|true)$/i.test(str(d[k]))).map(k => k.slice(prefix.length).trim());
  const products = picked('Product:'); const locations = picked('Location:');
  const qty = parseInt(str(d.Quantity).replace(/[^\d]/g, ''), 10);
  const date = str(d['Preferred date']);
  const details = [
    products.length ? `Products: ${products.join(', ')}` : null,
    locations.length ? `Print locations: ${locations.join(', ')}` : null,
    str(d.Budget) ? `Budget per piece (customer's estimate): ${str(d.Budget)}` : null,
    date ? 'Preferred date is not guaranteed (as stated on the form).' : null,
    [d.utm_source, d.utm_medium, d.utm_campaign].some(v => str(v) && str(v) !== 'direct') ? `Came from: ${[d.utm_source, d.utm_medium, d.utm_campaign, d.utm_content].map(str).filter(Boolean).join(' / ')}` : null,
  ].filter(Boolean);
  return {
    fields: {
      name: str(d.name).slice(0, 120), company: str(d.Company).slice(0, 160) || undefined, email: str(d.email).slice(0, 200) || undefined,
      phone: str(d.phone).slice(0, 40), product_type: products.join(', ').slice(0, 80) || undefined, quantity: Number.isFinite(qty) && qty > 0 ? Math.min(qty, 100000) : undefined,
      decoration: DECOR[str(d.Decoration)] || undefined, deadline: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      message: str(d.body).slice(0, 4000) || undefined, form: 'quote',
    },
    details,
  };
}

router.post('/:key/shopify-quote', express.text({ type: () => true, limit: '64kb' }), async (req, res) => {
  const businessId = await businessByKey(req.params.key);
  if (!limit(`sq:${req.ip}`, 10, 3600_000)) return res.status(429).end();
  let data = req.body;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return res.status(400).json({ error: 'Expected JSON' }); } }
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected JSON' });
  const { fields, details } = mapShopifyQuote(data);
  const f = parse(form, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
  await ingestWebsiteRequest(businessId, f, { details, via: 'dssuniforms.com Get a Quote form' });
  res.status(204).end(); // the browser sends this in the background; nothing is shown to the visitor
});

export default router;
