import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { DateTime } from 'luxon';

export function normalizePhone(raw, defaultCountry = 'US') {
  if (!raw) return null;
  const s = String(raw).replace(/^whatsapp:/i, '').trim();
  const p = parsePhoneNumberFromString(s, defaultCountry);
  return p && p.isValid() ? p.number : null;
}

// Carrier-standard opt-out / opt-in keywords (whole message, case-insensitive) plus common phrasings.
const STOP_WORDS = ['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out', 'revoke', 'remove me', 'do not text', "don't text", 'dont text', 'stop texting', 'stop messaging', 'stop calling', 'do not call', "don't call", 'dont call'];
const START_WORDS = ['start', 'unstop', 'yes', 'subscribe'];

export function classifyKeyword(text) {
  const t = String(text || '').toLowerCase().replace(/[.!\s]+$/g, '').trim();
  if (!t) return null;
  if (START_WORDS.includes(t)) return 'opt_in';
  if (t === 'help' || t === 'info') return 'help';
  if (STOP_WORDS.includes(t)) return 'opt_out';
  // phrase match for longer messages like "please stop texting me"
  if (/\b(stop|quit)\s+(texting|messaging|calling|contacting)\b|\bunsubscribe\b|\bdo not (text|call|contact)\b|\bremove me from\b/.test(t)) return 'opt_out';
  return null;
}

function inWindow(dt, startHHMM, endHHMM) {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const mins = dt.hour * 60 + dt.minute;
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

// Recipient time zone from a US area code, for Pacific-side states only (where DS Systems' customers are).
// Only area codes that lie entirely in one zone are listed; where a code crosses into a later zone, the later
// (stricter) zone is used. Anything else stays unknown and gets the all-US safe window.
const AREA_TZ = {};
const addTz = (tz, codes) => codes.forEach(c => { AREA_TZ[c] = tz; });
addTz('America/Los_Angeles', [209, 213, 279, 310, 323, 341, 350, 369, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951, // California
  206, 253, 360, 425, 509, 564, // Washington
  503, 971, // Oregon (west)
  702, 725]); // Las Vegas
addTz('America/Boise', [458, 541, 775]); // Oregon east / northern Nevada: partly Mountain time, so use the stricter zone
addTz('America/Phoenix', [480, 520, 602, 623, 928]); // Arizona

export function timezoneFor(contact) {
  if (contact?.timezone && DateTime.local().setZone(contact.timezone).isValid) return contact.timezone;
  const m = /^\+1(\d{3})/.exec(contact?.phone_e164 || '');
  return (m && AREA_TZ[Number(m[1])]) || null;
}

// When the recipient's timezone is unknown, the send must be inside the window in every
// continental US zone (Eastern…Pacific), which is the strictest safe choice.
const US_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

/** Campaign hours check: business window (default LA 09:00–17:00 Mon–Fri) and the recipient's local window. */
export function withinCampaignHours(hours, recipientTz, now = new Date()) {
  const base = DateTime.fromJSDate(now).setZone(hours.timezone);
  if (hours.days && !hours.days.includes(base.weekday)) return { ok: false, reason: 'Outside campaign days' };
  if (!inWindow(base, hours.start, hours.end)) return { ok: false, reason: `Outside ${hours.start}–${hours.end} ${hours.timezone}` };
  const zones = recipientTz && DateTime.local().setZone(recipientTz).isValid ? [recipientTz] : US_ZONES;
  for (const z of zones) {
    const local = DateTime.fromJSDate(now).setZone(z);
    if (!inWindow(local, hours.start, hours.end)) return { ok: false, reason: recipientTz ? `Outside recipient hours (${z})` : 'Recipient timezone unknown; outside the safe window for all US zones' };
  }
  return { ok: true };
}

/**
 * Can we contact this person for this purpose on this channel right now?
 * purpose: 'conversational' (replying in an active thread), 'transactional' (order updates), 'marketing'.
 */
export function checkContactAllowed({ contact, dncListed = false, purpose, channel, hours, now = new Date(), aiVoice = false }) {
  const reasons = [];
  if (contact.deleted_at) reasons.push('Contact deleted');
  if (contact.dnc || dncListed) {
    if (channel === 'voice' || purpose === 'marketing') reasons.push('On Do Not Call list');
  }
  if (channel === 'email') {
    // Email follows CAN-SPAM: no prior consent needed, but an unsubscribe is final and there are no sending hours.
    if (contact.email_opted_out_at) reasons.push('Unsubscribed from email');
    if (!contact.email) reasons.push('No email address');
    return { allowed: reasons.length === 0, reasons };
  }
  const isText = ['sms', 'whatsapp', 'mms'].includes(channel);
  const isMsg = isText || ['messenger', 'instagram'].includes(channel);
  if (contact.opted_out_at && isMsg) {
    // After STOP we only allow the one confirmation message, which the system sends itself.
    reasons.push(`Opted out${contact.opt_out_channel ? ` via ${contact.opt_out_channel}` : ''}`);
  }
  if (purpose === 'marketing') {
    if (isText && contact.sms_marketing !== 'opted_in') reasons.push('No SMS marketing consent on file');
    if (channel === 'voice') {
      if (contact.call_marketing === 'opted_out') reasons.push('Opted out of marketing calls');
      // AI-generated voice is treated as an artificial voice: prior express written consent is required.
      if (aiVoice && contact.call_marketing !== 'express_written') reasons.push('AI voice calls need written consent on file');
    }
    const h = withinCampaignHours(hours, timezoneFor(contact), now);
    if (!h.ok) reasons.push(h.reason);
  }
  return { allowed: reasons.length === 0, reasons };
}

/** WhatsApp/Messenger/Instagram only allow free-form replies within 24h of the customer's last message. */
export function replyWindowOpen(channel, lastInboundAt, now = new Date()) {
  if (!['whatsapp', 'messenger', 'instagram'].includes(channel)) return { open: true };
  if (!lastInboundAt) return { open: false, reason: 'The customer has not messaged on this channel yet' };
  const hrs = (now - new Date(lastInboundAt)) / 3600_000;
  if (hrs <= 24) return { open: true };
  if (channel !== 'whatsapp' && hrs <= 24 * 7) return { open: true, tag: 'HUMAN_AGENT', staffOnly: true };
  return { open: false, reason: channel === 'whatsapp' ? 'More than 24h since the customer wrote. Use an approved WhatsApp template.' : 'More than 7 days since the customer wrote; Meta does not allow a reply.' };
}
