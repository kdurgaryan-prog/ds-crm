import { Router } from 'express';
import twilio from 'twilio';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, notFound, AppError } from '../lib/http.js';
import { getChannel } from '../integrations/channels.js';
import { audit, activity } from '../services/audit.js';
import { config } from '../config.js';

const r = Router();

r.get('/', requirePerm('calls.read'), async (req, res) => {
  const { filter } = req.query;
  const page = Math.max(1, Number(req.query.page || 1)); const size = Math.min(100, Number(req.query.size || 50));
  const where = filter === 'missed' ? `where cl.status in ('missed','no-answer','busy') and cl.direction = 'inbound'`
    : filter === 'inbound' ? `where cl.direction = 'inbound'` : filter === 'outbound' ? `where cl.direction = 'outbound'`
    : filter === 'ai' ? `where cl.handled_by = 'ai'` : '';
  const out = await withBiz(req.ctx.businessId, async c => ({
    total: (await c.query(`select count(*)::int n from calls cl ${where}`)).rows[0].n,
    rows: (await c.query(`select cl.id, cl.direction, cl.status, cl.handled_by, cl.from_number, cl.to_number, cl.duration_sec, cl.summary, cl.outcome, cl.next_action,
              cl.recording_url is not null has_recording, cl.created_at, cl.handoff_reason, cl.post_call_sms, c.id contact_id, c.name contact_name, c.company, c.lead_no, u.name user_name
         from calls cl left join contacts c on c.id = cl.contact_id left join users u on u.id = cl.user_id ${where}
        order by cl.created_at desc limit ${size} offset ${(page - 1) * size}`)).rows,
  }));
  res.json({ ...out, page, size });
});

r.get('/token', requirePerm('calls.make'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => getChannel(c, 'voice'));
  if (out.status !== 'connected') throw new AppError(409, 'Phone calls are not connected yet.', { hint: 'Connect Twilio in Settings → Channels → Phone calls.' });
  if (!out.secrets.apiKeySid || !out.secrets.apiKeySecret || !out.config.twimlAppSid) throw new AppError(409, 'The browser phone needs a Twilio API key and TwiML App.', { hint: 'Add them in Settings → Channels → Phone calls.' });
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(out.secrets.accountSid, out.secrets.apiKeySid, out.secrets.apiKeySecret, { identity: `user-${req.ctx.userId}`, ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: out.config.twimlAppSid, incomingAllow: true }));
  res.json({ token: token.toJwt(), identity: `user-${req.ctx.userId}`, callerId: out.config.phoneNumber });
});

r.get('/setup-info', requirePerm('settings.read'), async (req, res) => {
  const base = `${config.publicUrl}/webhooks/twilio`;
  res.json({
    numberVoiceUrl: `${base}/voice/incoming`, numberStatusUrl: `${base}/voice/status`, messagingUrl: `${base}/messaging`,
    messageStatusUrl: `${base}/message-status`, twimlAppVoiceUrl: `${base}/voice/client?b=${req.ctx.businessId}`,
    metaWebhookUrl: `${config.publicUrl}/webhooks/meta`,
  });
});

r.get('/:id', requirePerm('calls.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const call = (await c.query(`select cl.*, c.name contact_name, c.lead_no from calls cl left join contacts c on c.id = cl.contact_id where cl.id = $1`, [req.params.id])).rows[0];
    if (!call) throw notFound();
    let postSms = null;
    if (call.post_call_sms?.startsWith('message:')) postSms = (await c.query('select status, status_detail from messages where id = $1', [call.post_call_sms.slice(8)])).rows[0] || null;
    return { ...call, post_sms_message: postSms };
  });
  res.json(out);
});

// Streams the recording through our server (Twilio recording URLs require the account's credentials).
r.get('/:id/recording', requirePerm('calls.read'), async (req, res) => {
  const { call, ch } = await withBiz(req.ctx.businessId, async c => ({ call: (await c.query('select recording_url from calls where id = $1', [req.params.id])).rows[0], ch: await getChannel(c, 'voice') }));
  if (!call?.recording_url) throw notFound('No recording for this call.');
  const auth = Buffer.from(`${ch.secrets.accountSid}:${ch.secrets.authToken}`).toString('base64');
  const r2 = await fetch(`${call.recording_url}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r2.ok) throw new AppError(502, 'Twilio did not return the recording.', { hint: 'It may still be processing. Try again in a minute.' });
  res.set('content-type', 'audio/mpeg');
  res.send(Buffer.from(await r2.arrayBuffer()));
});

r.patch('/:id', requirePerm('calls.make'), async (req, res) => {
  const b = parse(z.object({ outcome: z.string().max(200).nullish(), next_action: z.string().max(300).nullish(), summary: z.string().max(4000).nullish(), callbackAt: z.string().datetime().optional() }), req.body);
  const out = await withBiz(req.ctx.businessId, async c => {
    const call = (await c.query(`update calls set outcome = coalesce($2, outcome), next_action = coalesce($3, next_action), summary = coalesce($4, summary) where id = $1 returning *`,
      [req.params.id, b.outcome ?? null, b.next_action ?? null, b.summary ?? null])).rows[0];
    if (!call) throw notFound();
    if (b.callbackAt && call.contact_id) await c.query(`insert into tasks (business_id, contact_id, title, kind, due_at, assignee_user_id, created_by) values ($1,$2,$3,'callback',$4,$5,$5)`,
      [req.ctx.businessId, call.contact_id, `Call back${b.next_action ? `: ${b.next_action}` : ''}`, b.callbackAt, req.ctx.userId]);
    if (call.contact_id && b.outcome) await activity(c, req.ctx, call.contact_id, 'call', `Call outcome: ${b.outcome}${b.next_action ? ` · Next: ${b.next_action}` : ''}`, { refId: call.id });
    await audit(c, req.ctx, 'call.update', 'call', call.id, null, b);
    return call;
  });
  res.json(out);
});

export default r;
