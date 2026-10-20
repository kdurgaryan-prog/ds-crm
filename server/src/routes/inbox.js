import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, badRequest, notFound, AppError } from '../lib/http.js';
import { queueOutbound, upsertConversation } from '../services/messaging.js';
import { replyWindowOpen } from '../services/compliance.js';
import { getContact } from '../services/contacts.js';
import { audit, activity } from '../services/audit.js';
import { suggestReply } from '../agents/natalie.js';
import { llmAvailable } from '../agents/llm.js';
import { saveBuffer, isAllowedMime, MAX_UPLOAD } from '../services/files.js';
import { enqueue } from '../jobs/queue.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 5 } });

r.get('/', requirePerm('inbox.read'), async (req, res) => {
  const { channel, status, assignee, needs_reply, q } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)); const size = Math.min(100, Number(req.query.size || 40));
  const where = []; const vals = [];
  const p = v => { vals.push(v); return `$${vals.length}`; };
  if (channel) where.push(`cv.channel = ${p(channel)}`);
  if (status) where.push(`cv.status = ${p(status)}`); else where.push(`cv.status <> 'done'`);
  if (assignee === 'me') where.push(`cv.assignee_user_id = ${p(req.ctx.userId)}`);
  else if (assignee === 'none') where.push('cv.assignee_user_id is null');
  else if (assignee) where.push(`cv.assignee_user_id = ${p(assignee)}`);
  if (needs_reply === '1') where.push('cv.needs_reply');
  if (q) {
    const like = p('%' + String(q).replace(/[%_]/g, '\\$&') + '%');
    const digits = String(q).replace(/\D/g, '');
    where.push(`(c.name ilike ${like} or c.company ilike ${like} or ('lead ' || c.lead_no) ilike ${like}${digits.length >= 4 ? ` or c.phone_e164 like ${p('%' + digits + '%')}` : ''})`);
  }
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const out = await withBiz(req.ctx.businessId, async c => {
    const total = (await c.query(`select count(*)::int n from conversations cv join contacts c on c.id = cv.contact_id ${w}`, vals)).rows[0].n;
    const rows = (await c.query(
      `select cv.*, c.name contact_name, c.company, c.lead_no, c.phone_e164, u.name assignee_name,
              (select body from messages m where m.conversation_id = cv.id order by created_at desc limit 1) last_body,
              (select direction from messages m where m.conversation_id = cv.id order by created_at desc limit 1) last_direction,
              (select status from messages m where m.conversation_id = cv.id and m.direction = 'out' order by created_at desc limit 1) last_out_status
         from conversations cv join contacts c on c.id = cv.contact_id left join users u on u.id = cv.assignee_user_id
         ${w} order by cv.needs_reply desc, cv.last_message_at desc limit ${size} offset ${(page - 1) * size}`, vals)).rows;
    return { total, rows };
  });
  res.json({ ...out, page, size });
});

async function loadConv(c, id) {
  const cv = (await c.query('select * from conversations where id = $1', [id])).rows[0];
  if (!cv) throw notFound('Conversation not found.');
  return cv;
}

r.get('/:id', requirePerm('inbox.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const cv = await loadConv(c, req.params.id);
    const contact = await getContact(c, cv.contact_id);
    const messages = (await c.query(`select m.*, u.name author_name from messages m left join users u on u.id = m.author_user_id where conversation_id = $1 order by created_at`, [cv.id])).rows;
    await c.query('update conversations set unread = 0 where id = $1', [cv.id]);
    const others = (await c.query(`select id, channel, last_message_at from conversations where contact_id = $1 and id <> $2`, [contact.id, cv.id])).rows;
    const window = replyWindowOpen(cv.channel, cv.last_inbound_at);
    return { conversation: cv, contact, messages, otherChannels: others, replyWindow: window, aiAvailable: llmAvailable() };
  });
  res.json(out);
});

// Reply on the same channel (files allowed). A staff reply pauses Natalie on this conversation.
r.post('/:id/reply', requirePerm('inbox.reply'), upload.array('files', 5), async (req, res) => {
  const body = String(req.body.body || '').slice(0, 4000);
  const subject = String(req.body.subject || '').trim().slice(0, 200) || null;
  const key = req.get('idempotency-key') || req.body.idempotencyKey || null;
  const files = req.files || [];
  for (const f of files) if (!isAllowedMime(f.mimetype)) throw badRequest(`"${f.originalname}" cannot be sent.`, { hint: 'Images and PDFs work on most channels.' });
  const msg = await withBiz(req.ctx.businessId, async c => {
    const cv = await loadConv(c, req.params.id);
    if (cv.channel === 'website_forms') throw badRequest('Website form requests cannot be answered in place.', { hint: 'Reply by SMS or call — use "Start SMS" on the customer card.' });
    const media = [];
    for (const f of files) {
      const k = saveBuffer(req.ctx.businessId, f.buffer, f.originalname);
      const row = (await c.query(`insert into files (business_id, contact_id, kind, filename, mime, size, storage_key, uploaded_by) values ($1,$2,'attachment',$3,$4,$5,$6,$7) returning id`,
        [req.ctx.businessId, cv.contact_id, f.originalname, f.mimetype, f.size, k, req.ctx.userId])).rows[0];
      media.push({ fileId: row.id, filename: f.originalname, mime: f.mimetype });
    }
    if (cv.ai_enabled) await c.query(`update conversations set ai_enabled = false, ai_paused_reason = 'Staff replied' where id = $1`, [cv.id]);
    if (!cv.assignee_user_id) await c.query(`update conversations set assignee_user_id = $2 where id = $1`, [cv.id, req.ctx.userId]);
    return queueOutbound(c, req.ctx, { conversation: { ...cv }, body, media, authorType: 'user', purpose: 'conversational', key: key ? `ui:${key}` : null, subject });
  });
  if (msg.status === 'blocked') return res.status(422).json({ error: `Not sent: ${msg.status_detail}`, code: 'blocked', message: msg, hint: 'Nothing was delivered. Check the customer\'s permissions or use another channel.' });
  res.status(201).json(msg);
});

// Start a new thread with a customer (e.g., SMS to a website-form lead)
r.post('/start', requirePerm('inbox.reply'), async (req, res) => {
  const { contactId, channel } = parse(z.object({ contactId: z.string().uuid(), channel: z.enum(['sms', 'whatsapp', 'email']) }), req.body);
  const cv = await withBiz(req.ctx.businessId, async c => {
    const ct = await getContact(c, contactId);
    if (channel === 'email') {
      if (!ct.email) throw badRequest('This customer has no email address.');
      return upsertConversation(c, req.ctx, { contactId: ct.id, channel, thread: ct.email.toLowerCase() });
    }
    if (!ct.phone_e164) throw badRequest('This customer has no phone number.');
    return upsertConversation(c, req.ctx, { contactId: ct.id, channel, thread: ct.phone_e164 });
  });
  res.json(cv);
});

r.post('/:id/retry/:messageId', requirePerm('inbox.reply'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const m = (await c.query(`select * from messages where id = $1 and conversation_id = $2`, [req.params.messageId, req.params.id])).rows[0];
    if (!m) throw notFound();
    if (m.status !== 'failed' && m.status !== 'unknown') throw new AppError(409, `Only failed messages can be retried (this one is ${m.status}).`);
    if (m.status === 'unknown' && !req.body?.confirmNotDelivered) throw new AppError(409, 'This message may already have reached the customer.', { code: 'confirm_needed', hint: 'Check with the customer first. Confirm only if they did not get it.' });
    await c.query(`update messages set status = 'queued', status_detail = 'Retry requested by staff' where id = $1`, [m.id]);
    await enqueue(c, req.ctx.businessId, 'message.send', { messageId: m.id }, { key: `send:${m.id}:retry:${Date.now()}` });
    await audit(c, req.ctx, 'message.retry', 'message', m.id);
    return { ok: true };
  });
  res.json(out);
});

r.post('/:id/suggest', requirePerm('inbox.reply'), async (req, res) => {
  if (!llmAvailable()) throw new AppError(409, 'AI is not set up yet.', { hint: 'Add the AI key in server settings (see Settings → Channels → AI).' });
  const text = await suggestReply(req.ctx.businessId, req.ctx, req.params.id);
  res.json({ text });
});

r.patch('/:id', requirePerm('inbox.reply'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['open', 'pending', 'done']).optional(), assignee_user_id: z.string().uuid().nullable().optional(), ai_enabled: z.boolean().optional() }), req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const cv = await loadConv(c, req.params.id);
    const sets = []; const vals = [cv.id];
    if (b.status) { vals.push(b.status); sets.push(`status = $${vals.length}`); if (b.status === 'done') sets.push('needs_reply = false'); }
    if (b.assignee_user_id !== undefined) {
      vals.push(b.assignee_user_id); sets.push(`assignee_user_id = $${vals.length}`);
      // handing to a person pauses AI until someone turns it back on
      if (b.assignee_user_id) sets.push(`ai_enabled = false, ai_paused_reason = 'Assigned to staff'`);
    }
    if (b.ai_enabled !== undefined) { vals.push(b.ai_enabled); sets.push(`ai_enabled = $${vals.length}`); sets.push(`ai_paused_reason = ${b.ai_enabled ? 'null' : `'Turned off by staff'`}`); }
    if (!sets.length) return cv;
    const after = (await c.query(`update conversations set ${sets.join(', ')} where id = $1 returning *`, vals)).rows[0];
    await audit(c, req.ctx, 'conversation.update', 'conversation', cv.id, { status: cv.status, assignee: cv.assignee_user_id, ai: cv.ai_enabled }, { status: after.status, assignee: after.assignee_user_id, ai: after.ai_enabled });
    if (b.assignee_user_id) {
      const u = (await c.query('select name from users where id = $1', [b.assignee_user_id])).rows[0];
      await activity(c, req.ctx, cv.contact_id, 'status', `Conversation assigned to ${u?.name || 'staff'}`);
    }
    return after;
  });
  res.json(out);
});

// canned replies
r.get('/canned/list', requirePerm('inbox.read'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, async c => (await c.query('select * from canned_replies order by title')).rows));
});
r.post('/canned/list', requirePerm('settings.write'), async (req, res) => {
  const b = parse(z.object({ title: z.string().min(1).max(80), body: z.string().min(1).max(2000) }), req.body);
  res.status(201).json(await withBiz(req.ctx.businessId, async c => (await c.query('insert into canned_replies (business_id, title, body) values ($1,$2,$3) returning *', [req.ctx.businessId, b.title, b.body])).rows[0]));
});
r.delete('/canned/:cid', requirePerm('settings.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, c => c.query('delete from canned_replies where id = $1', [req.params.cid]));
  res.json({ ok: true });
});

export default r;
