const TZ = 'America/Los_Angeles';
export const money = n => (n === null || n === undefined ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n)));
export function phone(e164) {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
export function dateShort(d) {
  if (!d) return '';
  const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00') : new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: dt.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined, timeZone: /^\d{4}-\d{2}-\d{2}$/.test(d) ? undefined : TZ });
}
export function dateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
}
export function ago(d) {
  if (!d) return '';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return dateShort(d);
}
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00'); const t = new Date(); t.setHours(12, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}
export const CHANNEL = { sms: 'SMS', mms: 'MMS', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', webchat: 'Website chat', website_forms: 'Website form', voice: 'Phone', email: 'Email' };
export const leadName = c => c ? (c.name || c.company || `Lead ${c.lead_no}`) : '';
export const STATUS_TONE = { New: 'blue', Contacted: '', Waiting: 'amber', Qualified: 'blue', 'Quote Sent': 'blue', Won: 'green', Lost: 'red' };
export const ORDER_TONE = { New: 'blue', 'Awaiting Artwork': 'amber', 'Awaiting Approval': 'amber', 'Awaiting Payment': 'amber', 'In Production': 'blue', 'Quality Check': 'blue', Ready: 'green', Delivered: 'green', Canceled: 'red' };
export const MSG_STATUS = {
  received: ['Received', ''], queued: ['Sending…', ''], sending: ['Sending…', ''], sent: ['Sent', 'blue'], delivered: ['Delivered', 'green'],
  failed: ['Not delivered', 'red'], unknown: ['Status unknown', 'amber'], sandbox: ['Test mode — not delivered', 'amber'], blocked: ['Not sent', 'red'],
};
