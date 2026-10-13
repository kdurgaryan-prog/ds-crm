// Low-level delivery. Returns provider truth; throws on failure. Sandbox never touches the network.
import twilio from 'twilio';
import { getChannel, GRAPH, deliveryMode, CHANNELS } from './channels.js';
import { RetryableError, PermanentError } from '../jobs/queue.js';
import { config } from '../config.js';

let transport = null; // tests can inject a fake provider transport
export function setTransport(t) { transport = t; }

function twilioClient(ch) { return twilio(ch.secrets.accountSid, ch.secrets.authToken); }

function classifyTwilioError(e) {
  // 4xx client errors (bad number, unsubscribed recipient 21610, etc.) are permanent; 429/5xx/network are retryable.
  const status = e.status || e.statusCode;
  const msg = `Twilio ${e.code ? `error ${e.code}` : ''}: ${e.message}`.trim();
  if (status === 429 || !status || status >= 500) return new RetryableError(msg);
  return new PermanentError(msg);
}

/**
 * @returns {Promise<{status:'sent'|'sandbox', providerId?:string}>}
 */
export async function deliver(c, { channel, to, body, media = [], tag = null, template = null, statusCallback = null }) {
  if (channel === 'webchat') return { status: 'sent', providerId: null }; // stored; the widget fetches it
  const ch = await getChannel(c, channel === 'mms' ? 'sms' : channel);
  if (ch.status !== 'connected') throw new PermanentError(`${CHANNELS[channel === 'mms' ? 'sms' : channel]?.label || channel} is not connected${ch.status === 'error' ? ` (${ch.last_error})` : ''}. Connect it in Settings → Channels, then press Try again.`);
  if (transport) return transport({ channel, to, body, media, tag, template });
  if (deliveryMode() !== 'live') return { status: 'sandbox', providerId: null };

  if (channel === 'sms' || channel === 'mms' || channel === 'whatsapp') {
    const isWa = channel === 'whatsapp';
    const params = {
      to: isWa ? `whatsapp:${to}` : to,
      statusCallback: statusCallback || `${config.publicUrl}/webhooks/twilio/message-status`,
    };
    if (isWa) params.from = `whatsapp:${ch.config.whatsappNumber}`;
    else if (ch.config.messagingServiceSid) params.messagingServiceSid = ch.config.messagingServiceSid;
    else params.from = ch.config.phoneNumber;
    if (template?.contentSid) { params.contentSid = template.contentSid; if (template.variables) params.contentVariables = JSON.stringify(template.variables); }
    else params.body = body;
    if (media.length) params.mediaUrl = media.map(m => m.url);
    try {
      const m = await twilioClient(ch).messages.create(params);
      if (m.status === 'failed' || m.status === 'undelivered') throw new PermanentError(`Twilio reports ${m.status}: ${m.errorMessage || m.errorCode || ''}`);
      return { status: 'sent', providerId: m.sid };
    } catch (e) { throw e instanceof PermanentError ? e : classifyTwilioError(e); }
  }

  if (channel === 'messenger' || channel === 'instagram') {
    const payload = {
      recipient: { id: to },
      messaging_type: tag ? 'MESSAGE_TAG' : 'RESPONSE',
      ...(tag ? { tag } : {}),
      message: media.length ? { attachment: { type: (media[0].mime || '').startsWith('image/') ? 'image' : 'file', payload: { url: media[0].url, is_reusable: false } } } : { text: body },
    };
    const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(ch.secrets.pageAccessToken)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(e => { throw new RetryableError(`Meta network error: ${e.message}`); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = `Meta: ${j.error?.message || `HTTP ${r.status}`}`;
      throw (r.status >= 500 || r.status === 429 || j.error?.is_transient) ? new RetryableError(msg) : new PermanentError(msg);
    }
    if (media.length && body) { // send text after the attachment; report honestly if only the attachment went through
      const r2 = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(ch.secrets.pageAccessToken)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, message: { text: body } }),
      }).catch(() => null);
      if (!r2?.ok) return { status: 'sent', providerId: j.message_id, detail: 'The attachment was delivered but the text part failed. Send the text again.' };
    }
    return { status: 'sent', providerId: j.message_id };
  }
  throw new PermanentError(`Unsupported channel ${channel}`);
}
