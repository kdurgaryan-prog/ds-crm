// Twilio webhooks: SMS/MMS/WhatsApp inbound + status, voice (calls, ConversationRelay, softphone), with signature checks.
import { Router } from 'express';
import express from 'express';
import twilio from 'twilio';
import crypto from 'node:crypto';
import { withSystem, withBiz } from '../db.js';
import { config, deliveryIsLive } from '../config.js';
import { getChannel } from './channels.js';
import { handleInbound } from '../services/messaging.js';
import { normalizePhone } from '../services/compliance.js';
import { resolveInboundContact } from '../services/contacts.js';
import { getSettings } from '../services/settings.js';
import { activity } from '../services/audit.js';
import { enqueue } from '../jobs/queue.js';
import { inboundGreeting, outboundOpener, VOICE_LANG_CODES } from '../agents/natalie.js';
import { llmAvailable } from '../agents/llm.js';
import { saveBuffer } from '../services/files.js';

const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

export async function routeBusiness(provider, address) {
  if (!address) return null;
  return withSystem(async c => (await c.query('select business_id from channel_routes where provider = $1 and address = $2', [provider, address])).rows[0]?.business_id || null);
}

/** Validate X-Twilio-Signature with the auth token of the business that owns this webhook. */
async function verifyTwilio(req, businessId) {
  const sig = req.get('x-twilio-signature');
  if (!sig || !businessId) return false;
  const tokens = await withBiz(businessId, async c => {
    const out = [];
    for (const ch of ['voice', 'sms', 'whatsapp']) { const a = await getChannel(c, ch); if (a.secrets?.authToken) out.push(a.secrets.authToken); }
    return [...new Set(out)];
  });
  const url = config.publicUrl + req.originalUrl;
  return tokens.some(t => twilio.validateRequest(t, sig, url, req.body || {}));
}

export function relayToken(businessId, callId) {
  return crypto.createHmac('sha256', crypto.createHash('sha256').update('relay:' + (config.encryptionKey || 'dev')).digest()).update(`${businessId}:${callId}`).digest('base64url');
}

function cb(path, businessId, callId) {
  return `${config.publicUrl}/webhooks/twilio/voice/${path}?b=${businessId}${callId ? `&callId=${callId}` : ''}`;
}

function relayTwiml(r, { businessId, callId, greeting, settings, outbound = false }) {
  const connect = r.connect({ action: cb('relay-done', businessId, callId) });
  const wsUrl = `${config.publicUrl.replace(/^http/, 'ws')}/ws/relay?b=${businessId}&callId=${callId}&t=${relayToken(businessId, callId)}`;
  const relay = connect.conversationRelay({
    url: wsUrl,
    welcomeGreeting: greeting,
    welcomeGreetingInterruptible: 'none', // the AI disclosure is always heard in full
    language: 'en-US',
    interruptible: 'speech',              // real speech pauses her …
    interruptSensitivity: 'low',          // … but background noise does not
    ignoreBackchannel: 'true',            // "uh-huh", "okay" don't cut her off
    reportInputDuringAgentSpeech: 'none',
    dtmfDetection: 'true',
    hints: 'DS Systems, embroidery, DTF, screen printing, polos, hoodies, hi-vis, safety vests',
  });
  for (const code of settings.agents.natalie.languages.filter(l => l !== 'en')) relay.language({ code: VOICE_LANG_CODES[code] });
  relay.parameter({ name: 'mode', value: outbound ? 'outbound_call' : 'inbound_call' });
  return r;
}

async function staffDial(r, c, businessId, callId, settings, { record = false } = {}) {
  const users = (await c.query(`select user_id from memberships where business_id = $1 and active and role in ('owner','admin','sales')`, [businessId])).rows;
  const dial = r.dial({
    timeout: settings.calls.ringTimeoutSec || 20, action: cb('dial-done', businessId, callId),
    ...(record ? { record: 'record-from-answer-dual', recordingStatusCallback: cb('recording', businessId, callId) } : {}),
  });
  for (const u of users) dial.client(`user-${u.user_id}`);
  if (settings.calls.handoffNumber) dial.number(settings.calls.handoffNumber);
  return r;
}

const router = Router();
router.use(express.urlencoded({ extended: false, limit: '256kb' }));

function twiml(res, r) { res.type('text/xml').send(r.toString()); }

// ---------- messaging ----------
router.post('/messaging', async (req, res) => {
  const b = req.body;
  const isWa = String(b.To || '').startsWith('whatsapp:');
  const to = String(b.To || '').replace(/^whatsapp:/, '');
  const businessId = await routeBusiness(isWa ? 'whatsapp_number' : 'twilio_number', to);
  if (!businessId || !(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const media = [];
  const n = Number(b.NumMedia || 0);
  for (let i = 0; i < n; i++) media.push({ url: b[`MediaUrl${i}`], mime: b[`MediaContentType${i}`] });
  const phone = normalizePhone(b.From);
  await withBiz(businessId, async c => {
    const ctx = { businessId };
    // provider retries are deduped by MessageSid — recorded in the same transaction, so a failure lets the retry through
    const fresh = (await c.query(`insert into webhook_events (provider, event_id, business_id) values ('twilio', $1, $2) on conflict do nothing returning 1`, [b.MessageSid, businessId])).rowCount;
    if (!fresh) return;
    // fetch media into our storage (Twilio media URLs need auth); failures keep the original URL
    if (media.length) {
      const ch = await getChannel(c, isWa ? 'whatsapp' : 'sms');
      for (const m of media) {
        try {
          const auth = Buffer.from(`${ch.secrets.accountSid}:${ch.secrets.authToken}`).toString('base64');
          const r = await fetch(m.url, { headers: { Authorization: `Basic ${auth}` } });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            const key = saveBuffer(businessId, buf, `mms${(m.mime || '').includes('png') ? '.png' : (m.mime || '').includes('pdf') ? '.pdf' : '.jpg'}`);
            const f = (await c.query(`insert into files (business_id, filename, mime, size, storage_key, kind) values ($1,$2,$3,$4,$5,'attachment') returning id`, [businessId, `${isWa ? 'whatsapp' : 'mms'}-${Date.now()}`, m.mime, buf.length, key])).rows[0];
            m.fileId = f.id; delete m.url;
          }
        } catch { /* keep provider url */ }
      }
    }
    const r = await handleInbound(c, ctx, { channel: isWa ? 'whatsapp' : 'sms', thread: phone, phone, name: b.ProfileName || null, body: b.Body || '', media, providerId: b.MessageSid });
    if (r.contact) for (const m of media.filter(x => x.fileId)) await c.query('update files set contact_id = $2 where id = $1', [m.fileId, r.contact.id]);
    await c.query(`update channel_accounts set status = 'connected', last_error = null, last_checked_at = now() where channel = $1 and status <> 'connected' and secrets_enc is not null`, [isWa ? 'whatsapp' : 'sms']);
  });
  twiml(res, new MessagingResponse()); // empty: replies are sent through the API after processing
});

router.post('/message-status', async (req, res) => {
  const b = req.body;
  const from = String(b.From || '').replace(/^whatsapp:/, '');
  const businessId = await routeBusiness(String(b.From || '').startsWith('whatsapp:') ? 'whatsapp_number' : 'twilio_number', from)
    || (b.MessagingServiceSid ? await routeBusiness('twilio_msid', b.MessagingServiceSid) : null);
  if (!businessId || !(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const map = { delivered: 'delivered', read: 'delivered', sent: 'sent', failed: 'failed', undelivered: 'failed' };
  const st = map[b.MessageStatus];
  if (st) await withBiz(businessId, c => c.query(
    `update messages set status = $2, status_detail = case when $2 = 'failed' then $3 else status_detail end
      where provider_message_id = $1 and status not in ('delivered') and not (status = 'failed' and $2 = 'sent')`,
    [b.MessageSid, st, `Carrier: ${b.ErrorCode ? `error ${b.ErrorCode}` : b.MessageStatus}${b.ErrorCode === '21610' ? ' (recipient has unsubscribed)' : ''}`]));
  res.sendStatus(204);
});

// ---------- voice ----------
router.post('/voice/incoming', async (req, res) => {
  const b = req.body;
  const businessId = await routeBusiness('twilio_number', b.To);
  if (!businessId || !(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const r = new VoiceResponse();
  await withBiz(businessId, async c => {
    const ctx = { businessId };
    const settings = await getSettings(c, businessId);
    const phone = normalizePhone(b.From);
    const { contact } = phone ? await resolveInboundContact(c, ctx, { channel: 'voice', address: phone, phone, name: b.CallerName || null, source: 'call' }) : { contact: null };
    const n = settings.agents.natalie;
    const ai = n.enabled && n.answerCalls && llmAvailable();
    const call = (await c.query(
      `insert into calls (business_id, contact_id, direction, from_number, to_number, provider_call_sid, status, handled_by, started_at)
       values ($1,$2,'inbound',$3,$4,$5,'ringing',$6, now())
       on conflict (business_id, provider_call_sid) where provider_call_sid is not null do update set status = calls.status returning *`,
      [businessId, contact?.id || null, b.From, b.To, b.CallSid, ai ? 'ai' : 'user'])).rows[0];
    if (contact) await activity(c, ctx, contact.id, 'call', `Incoming call${ai ? ` answered by ${n.displayName}` : ''}`, { refId: call.id });
    if (settings.calls.recordCalls) await enqueue(c, businessId, 'call.start_recording', { callId: call.id }, { key: `rec:${call.id}`, runAt: new Date(Date.now() + 3000), maxAttempts: 3 });
    if (ai) relayTwiml(r, { businessId, callId: call.id, settings, greeting: inboundGreeting(n.displayName, settings.calls.recordCalls ? settings.calls.recordingDisclosure : null) });
    else {
      if (settings.calls.recordCalls) r.say(settings.calls.recordingDisclosure);
      await staffDial(r, c, businessId, call.id, settings, { record: settings.calls.recordCalls });
    }
  });
  twiml(res, r);
});

// ConversationRelay ended: handoff requested, AI finished, or connection failed → transfer to staff.
router.post('/voice/relay-done', async (req, res) => {
  const { b: businessId, callId } = req.query;
  if (!(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const r = new VoiceResponse();
  await withBiz(businessId, async c => {
    const settings = await getSettings(c, businessId);
    let hd = {}; try { hd = JSON.parse(req.body.HandoffData || '{}'); } catch { hd = { reason: String(req.body.HandoffData) }; }
    const failed = req.body.ErrorCode || ['failed'].includes(req.body.SessionStatus);
    if (hd.reason === 'handoff' || failed) {
      const reason = failed ? `AI connection problem (${req.body.ErrorMessage || req.body.ErrorCode || req.body.SessionStatus})` : hd.detail || 'Customer asked for a person';
      await c.query(`update calls set handoff_reason = $2, handled_by = 'user' where id = $1`, [callId, reason]);
      r.say('One moment, I am connecting you with a team member.');
      await staffDial(r, c, businessId, callId, settings, { record: settings.calls.recordCalls });
    } else {
      r.hangup();
    }
  });
  twiml(res, r);
});

router.post('/voice/dial-done', async (req, res) => {
  const { b: businessId, callId } = req.query;
  if (!(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const r = new VoiceResponse();
  const st = req.body.DialCallStatus;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(st)) {
    await withBiz(businessId, async c => {
      const call = (await c.query(`update calls set status = 'missed' where id = $1 returning *`, [callId])).rows[0];
      if (call?.contact_id && call.direction === 'inbound') {
        await c.query(`insert into tasks (business_id, contact_id, title, kind, due_at) values ($1,$2,'Call back — missed call','callback', now() + interval '1 hour')`, [businessId, call.contact_id]);
        await activity(c, { businessId }, call.contact_id, 'call', 'Missed call — callback task created', { refId: callId });
      }
    });
    r.say('Sorry we missed you. Please leave a short message after the tone, and we will call you back.');
    r.record({ maxLength: 120, playBeep: true, recordingStatusCallback: cb('recording', businessId, callId) });
  } else r.hangup();
  twiml(res, r);
});

router.post('/voice/status', async (req, res) => {
  const { b: qb, callId } = req.query;
  const b = req.body;
  const businessId = qb || await routeBusiness('twilio_number', b.Direction === 'inbound' ? b.To : b.From);
  if (!businessId || !(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  await withBiz(businessId, async c => {
    const call = (await c.query(`select * from calls where ${callId ? 'id = $1' : 'provider_call_sid = $1'}`, [callId || b.CallSid])).rows[0];
    if (!call) return;
    const final = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(b.CallStatus);
    const status = call.status === 'missed' ? 'missed' : b.CallStatus;
    await c.query(`update calls set status = $2, provider_call_sid = coalesce(provider_call_sid, $3),
                    started_at = coalesce(started_at, case when $2 = 'in-progress' then now() end),
                    ended_at = case when $4 then now() else ended_at end, duration_sec = coalesce($5::int, duration_sec) where id = $1`,
      [call.id, status, b.CallSid, final, b.CallDuration || null]);
    if (final) {
      if (call.campaign_id) await c.query(`update campaign_recipients set status = 'called', updated_at = now() where campaign_id = $1 and contact_id = $2`, [call.campaign_id, call.contact_id]);
      await enqueue(c, businessId, 'call.summarize', { callId: call.id }, { key: `sum:${call.id}`, runAt: new Date(Date.now() + 5000), maxAttempts: 3 });
      if (b.CallStatus === 'completed' && Number(b.CallDuration || 0) > 0) await enqueue(c, businessId, 'call.post_sms', { callId: call.id }, { key: `postsms:${call.id}`, maxAttempts: 1 });
      if (b.CallStatus === 'no-answer' && call.direction === 'inbound' && call.contact_id && call.status !== 'missed') {
        await c.query(`update calls set status = 'missed' where id = $1`, [call.id]);
        await c.query(`insert into tasks (business_id, contact_id, title, kind, due_at) values ($1,$2,'Call back — missed call','callback', now() + interval '1 hour')`, [businessId, call.contact_id]);
      }
    }
  });
  res.sendStatus(204);
});

router.post('/voice/recording', async (req, res) => {
  const { b: businessId, callId } = req.query;
  if (!(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  if (req.body.RecordingStatus === 'completed' || req.body.RecordingUrl) {
    await withBiz(businessId, c => c.query(`update calls set recording_url = $2, recording_sid = $3 where id = $1`, [callId, req.body.RecordingUrl, req.body.RecordingSid]));
  }
  res.sendStatus(204);
});

// Browser softphone outbound (TwiML App voice URL: /webhooks/twilio/voice/client?b=<business id>)
router.post('/voice/client', async (req, res) => {
  const businessId = req.query.b;
  if (!(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const r = new VoiceResponse();
  const to = normalizePhone(req.body.To);
  const userId = String(req.body.From || '').replace(/^client:user-/, '');
  await withBiz(businessId, async c => {
    const settings = await getSettings(c, businessId);
    const voice = await getChannel(c, 'voice');
    if (!to) { r.say('That number is not valid.'); return; }
    const contact = (await c.query(`select c.* from contact_identities i join contacts c on c.id = i.contact_id where i.kind = 'phone' and i.value = $1 and c.merged_into is null limit 1`, [to])).rows[0];
    const dnc = (await c.query('select 1 from dnc_numbers where phone_e164 = $1', [to])).rowCount > 0 || contact?.dnc;
    if (dnc) { r.say('This number is on the Do Not Call list. The call was not placed.'); return; }
    const call = (await c.query(`insert into calls (business_id, contact_id, direction, from_number, to_number, provider_call_sid, status, handled_by, user_id, started_at)
                                 values ($1,$2,'outbound',$3,$4,$5,'initiated','user',$6, now()) returning id`,
      [businessId, contact?.id || null, voice.config.phoneNumber, to, req.body.CallSid, /^[0-9a-f-]{36}$/.test(userId) ? userId : null])).rows[0];
    if (contact) await activity(c, { businessId, userId }, contact.id, 'call', 'Outgoing call', { refId: call.id });
    if (settings.calls.recordCalls) r.say(settings.calls.recordingDisclosure);
    const dial = r.dial({ callerId: voice.config.phoneNumber, ...(settings.calls.recordCalls ? { record: 'record-from-answer-dual', recordingStatusCallback: cb('recording', businessId, call.id) } : {}) });
    dial.number({ statusCallback: cb('status', businessId, call.id), statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'] }, to);
  });
  twiml(res, r);
});

// Outbound AI campaign call answered
router.post('/voice/outbound-ai', async (req, res) => {
  const { b: businessId, callId } = req.query;
  if (!(await verifyTwilio(req, businessId))) return res.status(403).send('invalid signature');
  const r = new VoiceResponse();
  if (String(req.body.AnsweredBy || '').startsWith('machine') || req.body.AnsweredBy === 'fax') {
    await withBiz(businessId, c => c.query(`update calls set outcome = 'Voicemail — no message left', status = 'completed' where id = $1`, [callId]));
    r.hangup(); return twiml(res, r);
  }
  await withBiz(businessId, async c => {
    const s = await getSettings(c, businessId);
    if (!s.agents.natalie.enabled || !s.agents.natalie.outboundCalls) { r.hangup(); return; }
    relayTwiml(r, { businessId, callId, settings: s, outbound: true, greeting: outboundOpener(s.agents.natalie.displayName) + (s.calls.recordCalls ? ' ' + s.calls.recordingDisclosure : '') });
  });
  twiml(res, r);
});

export default router;
export { deliveryIsLive };
