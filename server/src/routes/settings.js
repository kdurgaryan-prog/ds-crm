import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { withBiz, withSystem } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, notFound, badRequest, AppError, forbidden } from '../lib/http.js';
import { getSettings, patchSettings } from '../services/settings.js';
import { CHANNELS, getChannel, saveChannel, verifyChannel, deliveryMode } from '../integrations/channels.js';
import { audit } from '../services/audit.js';
import { normalizePhone } from '../services/compliance.js';
import { registerHandler, enqueue } from '../jobs/queue.js';
import { ROLES } from '../lib/permissions.js';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- general settings ----------
r.get('/', requirePerm('settings.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const s = await getSettings(c, req.ctx.businessId);
    const biz = (await c.query('select name, slug, public_key from businesses where id = $1', [req.ctx.businessId])).rows[0];
    return { settings: s, business: biz, deliveryMode: deliveryMode(), appEnv: config.appEnv, publicUrl: config.publicUrl, siteOrigins: config.allowedSiteOrigins };
  });
  res.json(out);
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
r.patch('/', requirePerm('settings.write'), async (req, res) => {
  const b = parse(z.object({
    links: z.object({ quotePage: z.string().url().optional(), contactPage: z.string().url().optional() }).optional(),
    moq: z.object({ minQty: z.coerce.number().int().min(1).max(10000) }).optional(),
    campaignHours: z.object({ start: hhmm, end: hhmm, timezone: z.string(), days: z.array(z.number().int().min(1).max(7)) }).partial().optional(),
    calls: z.object({ recordCalls: z.boolean(), recordingDisclosure: z.string().max(200), handoffNumber: z.string().max(30), ringTimeoutSec: z.coerce.number().int().min(5).max(60),
      postCallSms: z.object({ enabled: z.boolean(), text: z.string().max(320) }) }).partial().optional(),
    quotes: z.object({ defaultTaxRate: z.coerce.number().min(0).max(0.5), validDays: z.coerce.number().int().min(1).max(180) }).partial().optional(),
    company: z.object({ legalName: z.string().max(120), website: z.string().url() }).partial().optional(),
    sms: z.object({ introText: z.string().min(10).max(1000).refine(t => /stop/i.test(t), 'The text must tell people how to opt out (for example "Reply STOP to opt out").'),
      keywords: z.array(z.string().regex(/^[A-Za-z0-9]{2,20}$/, 'Keywords are one word, letters and numbers only')).max(10), keywordOptIn: z.boolean(), autoTextWebLeads: z.boolean(),
      helpText: z.string().min(10).max(320) }).partial().optional(),
    phoneText: z.object({ template: z.string().min(10).max(640).refine(t => /stop/i.test(t), 'The text must tell people how to opt out (for example "Reply STOP and we won\'t text again").'),
      dailyLimit: z.coerce.number().int().min(1).max(500), repeatDays: z.coerce.number().int().min(1).max(365) }).partial().optional(),
  }).strict(), req.body);
  if (b.calls?.handoffNumber) {
    const n = normalizePhone(b.calls.handoffNumber);
    if (!n) throw badRequest('The handoff phone number is not valid.');
    b.calls.handoffNumber = n;
  }
  if (b.sms?.keywords) b.sms.keywords = [...new Set(b.sms.keywords.map(k => k.toUpperCase()))].filter(k => !['STOP', 'START', 'HELP', 'UNSTOP', 'CANCEL', 'END', 'QUIT', 'UNSUBSCRIBE', 'YES', 'INFO'].includes(k));
  if (b.campaignHours && b.campaignHours.start && b.campaignHours.end && b.campaignHours.start >= b.campaignHours.end) throw badRequest('Start time must be before end time.');
  // Federal quiet hours: no marketing calls or texts before 8:00 or after 21:00 in the recipient's local time.
  if (b.campaignHours?.start && b.campaignHours.start < '08:00') throw badRequest('Sending cannot start before 08:00 (US quiet hours).');
  if (b.campaignHours?.end && b.campaignHours.end > '21:00') throw badRequest('Sending must stop by 21:00 (US quiet hours).');
  const out = await withBiz(req.ctx.businessId, async c => {
    const before = await getSettings(c, req.ctx.businessId);
    const s = await patchSettings(c, req.ctx.businessId, b);
    if (b.links) await enqueue(c, req.ctx.businessId, 'links.check', {}, { key: `links:${Date.now()}`, maxAttempts: 1 });
    await audit(c, req.ctx, 'settings.update', 'settings', null, Object.fromEntries(Object.keys(b).map(k => [k, before[k]])), b);
    return s;
  });
  res.json(out);
});

// Natalie's links must actually work: checked from the server.
export async function checkLinks(c, businessId, fetchImpl = fetch) {
  const s = await getSettings(c, businessId);
  const checks = {};
  for (const url of [...new Set([s.links.quotePage, s.links.contactPage])]) {
    try {
      const resp = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'DS-CRM link check' } });
      checks[url] = { ok: resp.ok, status: resp.status, checkedAt: new Date().toISOString() };
    } catch (e) { checks[url] = { ok: false, status: null, error: e.cause?.code || e.message, checkedAt: new Date().toISOString() }; }
  }
  await patchSettings(c, businessId, { links: { checks } });
  return checks;
}
registerHandler('links.check', async job => withBiz(job.business_id, c => checkLinks(c, job.business_id)).then(() => ({})));
r.post('/links/check', requirePerm('settings.write'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, c => checkLinks(c, req.ctx.businessId)));
});

// ---------- channels ----------
r.get('/channels', requirePerm('settings.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const list = [];
    for (const [key, def] of Object.entries(CHANNELS)) {
      const ch = await getChannel(c, key);
      let status = ch.status || 'needs_setup';
      if (key === 'ai') status = config.anthropicApiKey ? (ch.status === 'connected' || ch.status === 'error' ? ch.status : 'needs_setup') : 'needs_setup';
      list.push({ channel: key, label: def.label, status, lastError: ch.last_error || (key === 'ai' && !config.anthropicApiKey ? 'ANTHROPIC_API_KEY is not set on the server' : null),
        lastCheckedAt: ch.last_checked_at, config: ch.config || {}, secretsSet: Object.fromEntries(def.secrets.map(k => [k, !!ch.secrets?.[k]])), fields: def });
    }
    return list;
  });
  res.json(out);
});

r.put('/channels/:channel', requirePerm('integrations.write'), async (req, res) => {
  const ch = req.params.channel;
  if (!CHANNELS[ch]) throw notFound('Unknown channel.');
  const b = parse(z.object({ config: z.record(z.string(), z.string().max(200)).default({}), secrets: z.record(z.string(), z.string().max(500)).default({}) }), req.body);
  if (b.config.phoneNumber) { const n = normalizePhone(b.config.phoneNumber); if (!n) throw badRequest('Phone number is not valid.'); b.config.phoneNumber = n; }
  if (b.config.whatsappNumber) { const n = normalizePhone(b.config.whatsappNumber); if (!n) throw badRequest('WhatsApp number is not valid.'); b.config.whatsappNumber = n; }
  if (!config.encryptionKey && Object.values(b.secrets).some(Boolean)) throw new AppError(500, 'The server has no encryption key, so credentials cannot be stored safely.', { hint: 'Set APP_ENCRYPTION_KEY on the server and restart.' });
  const status = await withBiz(req.ctx.businessId, async c => {
    const routes = await saveChannel(c, req.ctx.businessId, ch, b);
    await audit(c, req.ctx, 'channel.save', 'channel', ch, null, { config: b.config, secretsChanged: Object.keys(b.secrets) }); // never log secret values
    return { routes };
  });
  // routing table is global (webhooks arrive before we know the business)
  await withSystem(async c => {
    for (const [provider, address] of status.routes) {
      const taken = (await c.query('select business_id from channel_routes where provider = $1 and address = $2', [provider, address])).rows[0];
      if (taken && taken.business_id !== req.ctx.businessId) throw new AppError(409, 'That number/account is already connected to another business.');
      await c.query(`insert into channel_routes (provider, address, business_id) values ($1,$2,$3) on conflict (provider, address) do update set business_id = excluded.business_id`, [provider, address, req.ctx.businessId]);
    }
  });
  const result = await withBiz(req.ctx.businessId, c => verifyChannel(c, ch));
  res.json({ status: result });
});

r.post('/channels/:channel/verify', requirePerm('integrations.write'), async (req, res) => {
  res.json({ status: await withBiz(req.ctx.businessId, c => verifyChannel(c, req.params.channel)) });
});

r.delete('/channels/:channel', requirePerm('integrations.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    await c.query('delete from channel_accounts where channel = $1', [req.params.channel]);
    await audit(c, req.ctx, 'channel.disconnect', 'channel', req.params.channel);
  });
  await withSystem(c => c.query(`delete from channel_routes where business_id = $1 and provider = any($2)`, [req.ctx.businessId,
    { sms: ['twilio_number'], voice: ['twilio_number'], whatsapp: ['whatsapp_number'], messenger: ['fb_page'], instagram: ['ig_account'], shopify: ['shopify_domain'] }[req.params.channel] || []]));
  res.json({ ok: true });
});

// ---------- users & roles ----------
r.get('/users', requirePerm('users.manage'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, async c => (await c.query(`select u.id, u.name, u.email, m.active, m.role, m.created_at from memberships m join users u on u.id = m.user_id where m.business_id = app_biz() order by m.created_at`)).rows));
});

r.post('/users', requirePerm('users.manage'), async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(80), email: z.string().email(), role: z.enum(ROLES) }), req.body);
  if (b.role === 'owner' && req.ctx.role !== 'owner') throw forbidden('Only the owner can add another owner.');
  const tempPassword = randomToken(9);
  const user = await withSystem(async c => {
    let u = (await c.query('select id from users where lower(email) = lower($1)', [b.email])).rows[0];
    let isNew = false;
    if (!u) { u = (await c.query('insert into users (email, name, password_hash) values ($1,$2,$3) returning id', [b.email.toLowerCase(), b.name, await bcrypt.hash(tempPassword, 11)])).rows[0]; isNew = true; }
    const existing = (await c.query('select role from memberships where business_id = $1 and user_id = $2', [req.ctx.businessId, u.id])).rows[0];
    if (existing) throw badRequest('This person is already on the team.', { hint: 'Change their role in the list above instead.' });
    await c.query(`insert into memberships (business_id, user_id, role) values ($1,$2,$3)`, [req.ctx.businessId, u.id, b.role]);
    return { ...u, isNew };
  });
  await withBiz(req.ctx.businessId, c => audit(c, req.ctx, 'user.add', 'user', user.id, null, { email: b.email, role: b.role }));
  res.status(201).json(user.isNew
    ? { id: user.id, tempPassword, note: 'Share this temporary password privately. The user should change it after signing in.' }
    : { id: user.id, note: 'This person already has a login (from another business). They can sign in with their existing password.' });
});

r.patch('/users/:id', requirePerm('users.manage'), async (req, res) => {
  const b = parse(z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional() }), req.body);
  if (req.params.id === req.ctx.userId && (b.role && b.role !== req.ctx.role || b.active === false)) throw badRequest('You cannot change your own role or deactivate yourself.');
  await withSystem(async c => {
    const m = (await c.query('select role from memberships where business_id = $1 and user_id = $2', [req.ctx.businessId, req.params.id])).rows[0];
    if (!m) throw notFound();
    if ((m.role === 'owner' || b.role === 'owner') && req.ctx.role !== 'owner') throw forbidden('Only the owner can change owner access.');
    if (b.role) await c.query('update memberships set role = $3 where business_id = $1 and user_id = $2', [req.ctx.businessId, req.params.id, b.role]);
    if (b.active !== undefined) {
      // only for this business; their access to other businesses is untouched
      await c.query('update memberships set active = $3 where business_id = $1 and user_id = $2', [req.ctx.businessId, req.params.id, b.active]);
      if (!b.active) await c.query('delete from sessions where user_id = $1 and business_id = $2', [req.params.id, req.ctx.businessId]);
    }
  });
  await withBiz(req.ctx.businessId, c => audit(c, req.ctx, 'user.update', 'user', req.params.id, null, b));
  res.json({ ok: true });
});

// ---------- custom fields ----------
r.get('/fields', requirePerm('contacts.read'), async (req, res) => res.json(await withBiz(req.ctx.businessId, async c => (await c.query('select * from custom_fields order by position, label')).rows)));
r.post('/fields', requirePerm('settings.write'), async (req, res) => {
  const b = parse(z.object({ label: z.string().min(1).max(60), type: z.enum(['text', 'number', 'date', 'select', 'checkbox']), options: z.array(z.string().max(60)).default([]) }), req.body);
  const key = b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';
  res.status(201).json(await withBiz(req.ctx.businessId, async c => {
    const row = (await c.query(`insert into custom_fields (business_id, key, label, type, options, position) values ($1,$2,$3,$4,$5,(select coalesce(max(position),0)+1 from custom_fields)) returning *`,
      [req.ctx.businessId, key, b.label, b.type, JSON.stringify(b.options)])).rows[0];
    await audit(c, req.ctx, 'field.create', 'custom_field', row.id, null, b);
    return row;
  }));
});
r.delete('/fields/:id', requirePerm('settings.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => { await c.query('delete from custom_fields where id = $1', [req.params.id]); await audit(c, req.ctx, 'field.delete', 'custom_field', req.params.id); });
  res.json({ ok: true });
});

// ---------- saved views & personal look ----------
r.get('/views/:table', requirePerm('contacts.read'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, async c => (await c.query(`select * from ui_views where table_key = $1 and (user_id = $2 or user_id is null) order by user_id nulls first, name`, [req.params.table, req.ctx.userId])).rows));
});
const viewSchema = z.object({ name: z.string().min(1).max(60), config: z.object({ columns: z.array(z.object({ key: z.string(), width: z.number().min(40).max(800).optional(), hidden: z.boolean().optional() })), filters: z.record(z.string(), z.any()).optional(), sort: z.string().optional(), dir: z.string().optional(), rowHeight: z.number().min(28).max(96).optional(), wrapHeaders: z.boolean().optional() }), shared: z.boolean().default(false), is_default: z.boolean().default(false) });
r.post('/views/:table', requirePerm('contacts.read'), async (req, res) => {
  const b = parse(viewSchema, req.body);
  if (b.shared && !['owner', 'admin'].includes(req.ctx.role)) throw forbidden('Only the owner or an admin can share a view with everyone.');
  res.status(201).json(await withBiz(req.ctx.businessId, async c => {
    if (b.is_default) await c.query('update ui_views set is_default = false where table_key = $1 and user_id = $2', [req.params.table, req.ctx.userId]);
    return (await c.query(`insert into ui_views (business_id, user_id, table_key, name, config, is_default) values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.ctx.businessId, b.shared ? null : req.ctx.userId, req.params.table, b.name, b.config, b.is_default])).rows[0];
  }));
});
r.put('/views/:table/:id', requirePerm('contacts.read'), async (req, res) => {
  const b = parse(viewSchema.partial(), req.body);
  res.json(await withBiz(req.ctx.businessId, async c => {
    const v = (await c.query('select * from ui_views where id = $1', [req.params.id])).rows[0];
    if (!v) throw notFound();
    if (v.user_id === null && !['owner', 'admin'].includes(req.ctx.role)) throw forbidden('Shared views can only be changed by the owner or an admin.');
    if (v.user_id && v.user_id !== req.ctx.userId) throw forbidden();
    if (b.is_default) await c.query('update ui_views set is_default = false where table_key = $1 and user_id = $2', [req.params.table, req.ctx.userId]);
    return (await c.query(`update ui_views set name = coalesce($2, name), config = coalesce($3, config), is_default = coalesce($4, is_default), updated_at = now() where id = $1 returning *`,
      [v.id, b.name ?? null, b.config ?? null, b.is_default ?? null])).rows[0];
  }));
});
r.delete('/views/:table/:id', requirePerm('contacts.read'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    const v = (await c.query('select * from ui_views where id = $1', [req.params.id])).rows[0];
    if (!v) throw notFound();
    if ((v.user_id === null && !['owner', 'admin'].includes(req.ctx.role)) || (v.user_id && v.user_id !== req.ctx.userId)) throw forbidden();
    await c.query('delete from ui_views where id = $1', [v.id]);
  });
  res.json({ ok: true });
});

r.put('/prefs', async (req, res) => {
  const b = parse(z.object({ fontFamily: z.enum(['system', 'inter', 'serif', 'mono', 'atkinson']).optional(), fontSize: z.number().min(12).max(22).optional(), fontWeight: z.number().min(300).max(700).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(), density: z.enum(['compact', 'comfortable', 'spacious']).optional(), theme: z.enum(['auto', 'light', 'dark']).optional() }).strict(), req.body);
  const prefs = await withBiz(req.ctx.businessId, async c => (await c.query(
    `insert into user_prefs (business_id, user_id, prefs) values ($1,$2,$3) on conflict (business_id, user_id) do update set prefs = $3 returning prefs`, [req.ctx.businessId, req.ctx.userId, b])).rows[0].prefs);
  res.json(prefs);
});

// ---------- audit, failed actions ----------
r.get('/audit', requirePerm('audit.read'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  res.json(await withBiz(req.ctx.businessId, async c => (await c.query(`select a.*, u.name actor_name from audit_log a left join users u on u.id = a.actor_user_id order by a.created_at desc limit 100 offset ${(page - 1) * 100}`)).rows));
});

r.get('/jobs', requirePerm('jobs.manage'), async (req, res) => {
  const st = req.query.status || 'dead';
  res.json(await withBiz(req.ctx.businessId, async c => ({
    rows: (await c.query(`select id, kind, payload, status, attempts, max_attempts, last_error, run_at, updated_at from jobs where status = any($1) order by updated_at desc limit 200`, [String(st).split(',')])).rows,
    counts: (await c.query(`select status, count(*)::int n from jobs where updated_at > now() - interval '14 days' group by 1`)).rows,
  })));
});

r.post('/jobs/:id/retry', requirePerm('jobs.manage'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const j = (await c.query('select * from jobs where id = $1', [req.params.id])).rows[0];
    if (!j) throw notFound();
    if (j.status !== 'dead' && j.status !== 'failed') throw badRequest('Only failed actions can be retried.');
    // delivery with unknown outcome: make the person confirm it wasn't delivered
    if (j.kind === 'message.send') {
      const m = (await c.query('select status from messages where id = $1', [j.payload.messageId])).rows[0];
      if (m?.status === 'unknown' && !req.body?.confirmNotDelivered) throw new AppError(409, 'This message may already have been delivered.', { code: 'confirm_needed', hint: 'Check the conversation. Confirm only if the customer did not receive it.' });
      await c.query(`update messages set status = 'queued', status_detail = 'Retry requested' where id = $1 and status in ('failed','unknown')`, [j.payload.messageId]);
    }
    await c.query(`update jobs set status = 'pending', attempts = 0, run_at = now(), last_error = null, updated_at = now() where id = $1`, [j.id]);
    await audit(c, req.ctx, 'job.retry', 'job', j.id, null, { kind: j.kind });
    return { ok: true };
  });
  res.json(out);
});

r.post('/jobs/:id/dismiss', requirePerm('jobs.manage'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => { await c.query(`update jobs set status = 'canceled', updated_at = now() where id = $1 and status in ('dead','failed')`, [req.params.id]); await audit(c, req.ctx, 'job.dismiss', 'job', req.params.id); });
  res.json({ ok: true });
});

// ---------- Do Not Call list ----------
r.get('/dnc', requirePerm('contacts.read'), async (req, res) => res.json(await withBiz(req.ctx.businessId, async c => (await c.query('select * from dnc_numbers order by created_at desc limit 1000')).rows)));
r.post('/dnc', requirePerm('contacts.write'), upload.single('file'), async (req, res) => {
  const raw = req.file ? req.file.buffer.toString('utf8').split(/[\r\n,;]+/) : [String(req.body.phone || '')];
  const nums = [...new Set(raw.map(x => normalizePhone(x.trim())).filter(Boolean))];
  if (!nums.length) throw badRequest('No valid phone numbers found.');
  await withBiz(req.ctx.businessId, async c => {
    for (const n of nums) await c.query(`insert into dnc_numbers (business_id, phone_e164, source) values ($1,$2,$3) on conflict do nothing`, [req.ctx.businessId, n, req.file ? 'import' : 'manual']);
    await c.query(`update contacts set dnc = true where phone_e164 = any($1)`, [nums]);
    await audit(c, req.ctx, 'dnc.add', 'dnc', null, null, { count: nums.length });
  });
  res.status(201).json({ added: nums.length });
});
r.delete('/dnc/:phone', requirePerm('settings.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => { await c.query('delete from dnc_numbers where phone_e164 = $1', [req.params.phone]); await audit(c, req.ctx, 'dnc.remove', 'dnc', req.params.phone); });
  res.json({ ok: true });
});

// ---------- backups ----------
r.get('/backups', requirePerm('backup.manage'), async (req, res) => {
  res.json(await withSystem(async c => (await c.query('select * from backup_runs order by started_at desc limit 30')).rows));
});
r.post('/backups/run', requirePerm('backup.manage'), async (req, res) => {
  const script = new URL('../../../scripts/backup.sh', import.meta.url).pathname;
  if (!fs.existsSync(script)) throw new AppError(500, 'Backup script missing on server.');
  const child = spawn('bash', [script, '--verify'], { env: process.env, stdio: 'ignore', detached: true });
  child.unref();
  await withBiz(req.ctx.businessId, c => audit(c, req.ctx, 'backup.run', 'backup', null));
  res.status(202).json({ started: true, note: 'The backup runs in the background; refresh in a minute to see the result.' });
});

// Full export of this business's data (owner)
r.get('/export.json', requirePerm('backup.manage'), async (req, res) => {
  const data = await withBiz(req.ctx.businessId, async c => {
    const out = {};
    for (const t of ['contacts', 'contact_identities', 'conversations', 'messages', 'calls', 'tasks', 'activities', 'quotes', 'quote_items', 'orders', 'order_items', 'design_versions', 'campaigns', 'campaign_recipients', 'price_list', 'custom_fields', 'files', 'dnc_numbers', 'agent_actions']) {
      out[t] = (await c.query(`select * from ${t}`)).rows;
    }
    await audit(c, req.ctx, 'data.export', 'business', req.ctx.businessId);
    return out;
  });
  res.set('content-disposition', `attachment; filename="ds-crm-export-${new Date().toISOString().slice(0, 10)}.json"`).json({ exportedAt: new Date().toISOString(), business: req.ctx.businessId, ...data });
});

export default r;
