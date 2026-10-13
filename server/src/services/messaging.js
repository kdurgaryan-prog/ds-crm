// Conversations: inbound handling (dedupe, STOP, routing to Natalie) and outbound queueing with compliance checks.
import crypto from 'node:crypto';
import { enqueue, registerHandler, PermanentError } from '../jobs/queue.js';
import { withBiz } from '../db.js';
import { activity } from './audit.js';
import { checkContactAllowed, classifyKeyword, replyWindowOpen } from './compliance.js';
import { resolveInboundContact, getContact } from './contacts.js';
import { getSettings } from './settings.js';
import { deliver } from '../integrations/send.js';
import { badRequest } from '../lib/http.js';
import { signedMediaUrl } from './files.js';

export async function upsertConversation(c, ctx, { contactId, channel, thread }) {
  const { rows } = await c.query(
    `insert into conversations (business_id, contact_id, channel, external_thread_id)
     values ($1,$2,$3,$4)
     on conflict (business_id, channel, external_thread_id) do update set contact_id = conversations.contact_id
     returning *`, [ctx.businessId, contactId, channel, thread]);
  return rows[0];
}

async function isDncListed(c, phone) {
  if (!phone) return false;
  return (await c.query('select 1 from dnc_numbers where phone_e164 = $1', [phone])).rowCount > 0;
}

/**
 * Inbound message from any channel. Idempotent on provider message id.
 * @returns {{message, conversation, contact, duplicate?:boolean, keyword?:string}}
 */
export async function handleInbound(c, ctx, { channel, thread, phone = null, name = null, body = '', media = [], providerId = null, source = null }) {
  if (providerId) {
    const dup = (await c.query('select * from messages where channel = $1 and provider_message_id = $2', [channel, providerId])).rows[0];
    if (dup) return { duplicate: true, message: dup };
  }
  const { contact } = await resolveInboundContact(c, ctx, { channel, address: thread, phone, name, source });
  const conv = await upsertConversation(c, ctx, { contactId: contact.id, channel, thread });
  const msg = (await c.query(
    `insert into messages (business_id, conversation_id, contact_id, direction, channel, body, media, author_type, status, provider_message_id)
     values ($1,$2,$3,'in',$4,$5,$6,'customer','received',$7)
     on conflict do nothing returning *`,
    [ctx.businessId, conv.id, contact.id, channel, body, JSON.stringify(media), providerId])).rows[0];
  if (!msg) return { duplicate: true };
  await c.query(`update conversations set last_message_at = now(), last_inbound_at = now(), unread = unread + 1, needs_reply = true,
                  status = case when status = 'done' then 'open' else status end where id = $1`, [conv.id]);
  if (contact.status === 'Contacted' || contact.status === 'Waiting') { /* keep status; staff decides */ }
  await activity(c, ctx, contact.id, 'message', `${labelFor(channel)} from customer: ${trim(body || (media.length ? '[attachment]' : ''), 120)}`, { refId: msg.id, data: { channel, direction: 'in' } });

  const keyword = ['sms', 'whatsapp'].includes(channel) ? classifyKeyword(body) : (classifyKeyword(body) === 'opt_out' ? 'opt_out' : null);
  if (keyword === 'opt_out') {
    // revoking consent by any reasonable means: stop marketing texts and marketing calls
    await c.query(`update contacts set opted_out_at = now(), opt_out_channel = $2, sms_marketing = 'opted_out', call_marketing = 'opted_out' where id = $1`,
      [contact.id, channel]);
    // stop any pending marketing to this person
    await c.query(`update campaign_recipients set status = 'skipped', skip_reason = 'Opted out', updated_at = now() where contact_id = $1 and status in ('pending','queued')`, [contact.id]);
    await c.query(`update conversations set ai_enabled = false, ai_paused_reason = 'Customer opted out', needs_reply = false where id = $1`, [conv.id]);
    await activity(c, ctx, contact.id, 'status', `Opted out via ${labelFor(channel)} ("${trim(body, 40)}"). Marketing stopped.`);
    // SMS: Twilio's carrier-level opt-out sends the confirmation. Other channels: send one confirmation ourselves.
    if (channel !== 'sms') {
      await queueOutbound(c, ctx, { conversation: conv, body: "You're unsubscribed and won't receive more messages from DS Systems. Reply START to undo.", authorType: 'system', purpose: 'transactional', key: `optout-confirm:${msg.id}`, bypassOptOut: true });
    }
    return { message: msg, conversation: conv, contact, keyword };
  }
  if (keyword === 'opt_in' && contact.opted_out_at) {
    await c.query(`update contacts set opted_out_at = null, opt_out_channel = null, sms_marketing = 'unknown' where id = $1`, [contact.id]);
    await activity(c, ctx, contact.id, 'status', `Opted back in via ${labelFor(channel)} (START)`);
    return { message: msg, conversation: conv, contact, keyword };
  }

  // Natalie answers if enabled for the business and this conversation (and a staff member has not taken it over).
  const s = await getSettings(c, ctx.businessId);
  const n = s.agents.natalie;
  if (n.enabled && n.autoReplyMessages && conv.ai_enabled && !contact.opted_out_at) {
    await enqueue(c, ctx.businessId, 'natalie.reply', { conversationId: conv.id, messageId: msg.id },
      { key: `natalie:${conv.id}:${msg.id}`, runAt: new Date(Date.now() + 2500), maxAttempts: 3 });
  }
  return { message: msg, conversation: conv, contact, keyword };
}

/**
 * Queue an outbound message. Compliance is checked here; a blocked message is stored as "blocked" with the reason
 * (never shown as sent). The same idempotency key never creates a second message.
 */
export async function queueOutbound(c, ctx, { conversation, body, media = [], authorType = 'user', purpose = 'conversational', key = null, template = null, bypassOptOut = false }) {
  if (!body?.trim() && !media.length && !template) throw badRequest('Write a message or attach a file.');
  const contact = await getContact(c, conversation.contact_id);
  const s = await getSettings(c, ctx.businessId);
  const idem = key || `msg:${crypto.randomUUID()}`;
  const existing = (await c.query('select * from messages where idempotency_key = $1', [idem])).rows[0];
  if (existing) return existing;

  let blocked = null; let tag = null;
  if (!bypassOptOut) {
    const chk = checkContactAllowed({ contact, dncListed: await isDncListed(c, contact.phone_e164), purpose, channel: conversation.channel, hours: s.campaignHours });
    if (!chk.allowed) blocked = chk.reasons.join('; ');
  }
  if (!blocked && !template) {
    const w = replyWindowOpen(conversation.channel, conversation.last_inbound_at);
    if (!w.open) blocked = w.reason;
    else if (w.staffOnly && authorType !== 'user') blocked = 'Only a staff member can reply after 24 hours on this channel.';
    else tag = w.tag || null;
  }
  const msg = (await c.query(
    `insert into messages (business_id, conversation_id, contact_id, direction, channel, body, media, author_type, author_user_id, status, status_detail, idempotency_key, purpose)
     values ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [ctx.businessId, conversation.id, contact.id, conversation.channel, body || null, JSON.stringify(media), authorType, authorType === 'user' ? ctx.userId : null,
      blocked ? 'blocked' : 'queued', blocked, idem, purpose])).rows[0];
  if (!blocked) {
    await enqueue(c, ctx.businessId, 'message.send', { messageId: msg.id, tag, template }, { key: `send:${msg.id}`, maxAttempts: 5 });
    await c.query(`update conversations set last_message_at = now(), needs_reply = false, unread = 0 where id = $1`, [conversation.id]);
  }
  const who = authorType === 'ai' ? s.agents.natalie.displayName : authorType === 'system' ? 'System' : 'Staff';
  await activity(c, { ...ctx, agent: authorType === 'ai' ? 'natalie' : null }, contact.id, 'message',
    `${labelFor(conversation.channel)} ${blocked ? 'NOT sent' : 'queued'} by ${who}: ${trim(body || '[attachment]', 100)}${blocked ? ` — ${blocked}` : ''}`, { refId: msg.id, data: { channel: conversation.channel, direction: 'out', blocked } });
  return msg;
}

// --- job: actually deliver a queued message (exactly once) ---
registerHandler('message.send', async job => {
  // Step 1 (one transaction): final checks, then mark "sending" and commit before contacting the provider.
  const prep = await withBiz(job.business_id, async c => {
    const m = (await c.query('select * from messages where id = $1 for update', [job.payload.messageId])).rows[0];
    if (!m || m.status !== 'queued') return null; // already handled — never send twice
    const conv = (await c.query('select * from conversations where id = $1', [m.conversation_id])).rows[0];
    const contact = await getContact(c, m.contact_id);
    const block = async (detail, recipientStatus = 'skipped') => {
      await c.query(`update messages set status = 'blocked', status_detail = $2 where id = $1`, [m.id, detail]);
      const camp = /^camp:([0-9a-f-]{36}):/.exec(m.idempotency_key || '');
      if (camp) await c.query(`update campaign_recipients set status = $3, skip_reason = $4, updated_at = now() where campaign_id = $1 and contact_id = $2`, [camp[1], m.contact_id, recipientStatus, detail]);
      return null;
    };
    // the customer may have sent STOP while this was queued
    const isOptOutConfirmation = m.author_type === 'system' && m.purpose === 'transactional' && /unsubscribed/i.test(m.body || '');
    if (!isOptOutConfirmation && contact.opted_out_at && ['sms', 'whatsapp', 'messenger', 'instagram'].includes(m.channel)) return block('Customer opted out before sending');
    if (m.purpose === 'marketing') {
      const camp = /^camp:([0-9a-f-]{36}):/.exec(m.idempotency_key || '');
      if (camp) {
        const st = (await c.query('select status from campaigns where id = $1', [camp[1]])).rows[0]?.status;
        if (!['running', 'completed'].includes(st)) return block(`Campaign ${st || 'removed'} before sending`, st === 'paused' ? 'pending' : 'skipped');
      }
      const s = await getSettings(c, job.business_id);
      const chk = checkContactAllowed({ contact, dncListed: await isDncListed(c, contact.phone_e164), purpose: 'marketing', channel: m.channel, hours: s.campaignHours });
      if (!chk.allowed) return block(chk.reasons.join('; '), chk.reasons.every(r => /Outside|timezone unknown/.test(r)) ? 'pending' : 'skipped');
    }
    await c.query(`update messages set status = 'sending' where id = $1`, [m.id]);
    return { m, conv, contact };
  });
  if (!prep) return {};
  const { m, conv, contact } = prep;
  const to = ['sms', 'whatsapp', 'mms'].includes(m.channel) ? contact.phone_e164 || conv.external_thread_id : conv.external_thread_id;
  // Step 2: talk to the provider. Its answer — and only its answer — decides the status.
  let r; let error = null;
  try {
    const media = (m.media || []).map(x => ({ ...x, url: x.url || signedMediaUrl(job.business_id, x.fileId) }));
    r = await withBiz(job.business_id, c => deliver(c, { channel: m.media?.length && m.channel === 'sms' ? 'mms' : m.channel, to, body: m.body, media, tag: job.payload.tag, template: job.payload.template }));
  } catch (e) { error = e; }
  // Step 3: record the outcome. If the provider accepted it, it is never re-queued, even if recording fails.
  if (!error) {
    try {
      await withBiz(job.business_id, async c => {
        await c.query(`update messages set status = $2, provider_message_id = $3, status_detail = $4 where id = $1`,
          [m.id, r.status, r.providerId || null, r.status === 'sandbox' ? 'Sandbox mode: recorded, not delivered' : r.detail || null]);
        if (r.detail) await c.query(`update conversations set needs_reply = true where id = $1`, [m.conversation_id]);
        const camp = /^camp:([0-9a-f-]{36}):/.exec(m.idempotency_key || '');
        if (camp) await c.query(`update campaign_recipients set status = $3, updated_at = now() where campaign_id = $1 and contact_id = $2`, [camp[1], m.contact_id, r.status === 'sandbox' ? 'sandbox' : 'sent']);
      });
    } catch (e) {
      console.error('[message.send] delivered but could not record status', m.id, e.message);
      await withBiz(job.business_id, c => c.query(`update messages set status = 'unknown', status_detail = 'The provider accepted this message but saving the result failed. Check before resending.' where id = $1`, [m.id])).catch(() => {});
    }
    return {};
  }
  const willRetry = error.retryable !== false && job.attempts < job.max_attempts;
  await withBiz(job.business_id, async c => {
    await c.query(`update messages set status = $2, status_detail = $3 where id = $1`, [m.id, willRetry ? 'queued' : 'failed', willRetry ? `Retrying: ${error.message}` : error.message]);
    if (!willRetry) await c.query(`update conversations set needs_reply = true where id = $1`, [m.conversation_id]);
  });
  throw error;
});

export function labelFor(ch) {
  return { sms: 'SMS', mms: 'MMS', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', webchat: 'Website chat', website_forms: 'Website form', voice: 'Call' }[ch] || ch;
}
export function trim(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export { PermanentError };
