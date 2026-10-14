// Natalie's intro text to people who agreed to receive texts (keyword, website checkbox, or recorded by staff).
import { upsertConversation, queueOutbound } from './messaging.js';
import { getSettings } from './settings.js';
import { activity, logAgentAction } from './audit.js';
import { getChannel } from '../integrations/channels.js';

export const SMS_CONFIRMATION = 'DS Systems: Thanks for texting! You will get messages about custom uniforms. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.';

export function fillTemplate(text, contact) {
  const first = (contact.name || '').trim().split(/\s+/)[0] || 'there';
  return String(text || '').replaceAll('{first_name}', first).replaceAll('{company}', contact.company || 'your company').trim();
}

/** Records consent (with source and time) without sending anything. */
export async function recordSmsConsent(c, ctx, contact, source) {
  await c.query(`update contacts set sms_marketing = 'opted_in', sms_consent_at = now(), sms_consent_source = $2, opted_out_at = null, opt_out_channel = null where id = $1`, [contact.id, source]);
  await activity(c, ctx, contact.id, 'status', `Agreed to receive texts (${source})`);
}

/**
 * Sends the intro text once per contact and reason. Never twice; never without consent.
 * purpose 'conversational' = reply to something the person just did (keyword, form); 'marketing' = staff-initiated (campaign hours apply).
 */
export async function sendIntroSms(c, ctx, contact, { reason, purpose = 'conversational', author = 'ai', delayMs = 0 }) {
  const s = await getSettings(c, ctx.businessId);
  if (!contact.phone_e164) return { skipped: 'No phone number' };
  if ((await getChannel(c, 'sms')).status !== 'connected') return { skipped: 'SMS is not connected' };
  const fresh = (await c.query('select * from contacts where id = $1', [contact.id])).rows[0];
  if (fresh.sms_marketing !== 'opted_in' || fresh.opted_out_at) return { skipped: 'No SMS consent on file' };
  if (author === 'ai' && !s.agents.natalie.enabled) return { skipped: `${s.agents.natalie.displayName} is turned off` };
  const conv = await upsertConversation(c, ctx, { contactId: contact.id, channel: 'sms', thread: contact.phone_e164 });
  const msg = await queueOutbound(c, { ...ctx, agent: author === 'ai' ? 'natalie' : null }, {
    conversation: conv, body: fillTemplate(s.sms.introText, fresh), authorType: author, purpose, key: `intro:${contact.id}:${reason}`, delayMs,
  });
  if (author === 'ai') await logAgentAction(c, ctx.businessId, { agent: 'natalie', action: 'intro_sms', basedOn: { contactId: contact.id, consent: fresh.sms_consent_source, reason }, change: { messageId: msg.id }, result: msg.status === 'blocked' ? 'blocked' : 'ok', detail: msg.status_detail });
  return { message: msg, conversation: conv };
}
