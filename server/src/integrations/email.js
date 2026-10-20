// Email channel: outbound through the business mailbox (SMTP), replies pulled in by IMAP, one-click unsubscribe.
// Gmail: turn on 2-Step Verification, then create an App Password (Google Account → Security → App passwords).
import crypto from 'node:crypto';
import { config, deliveryIsLive } from '../config.js';
import { withBiz, withSystem } from '../db.js';
import { getChannel, EMAIL_DEFAULTS, setChannelStatus } from './channels.js';
import { RetryableError, PermanentError, registerHandler } from '../jobs/queue.js';

export const emailAddress = v => { const t = String(v || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) ? t : null; };

function mailbox(ch) {
  const cfg = { ...EMAIL_DEFAULTS, ...(ch.config || {}) };
  return { address: emailAddress(cfg.address), fromName: cfg.fromName || '', smtpHost: cfg.smtpHost, smtpPort: Number(cfg.smtpPort) || 465, imapHost: cfg.imapHost, password: ch.secrets?.password || '' };
}

let mailerOverride = null;   // tests: { sendMail, verify }
export function setMailer(m) { mailerOverride = m; }
async function smtp(ch) {
  const nodemailer = (await import('nodemailer')).default;
  const m = mailbox(ch);
  if (!m.address || !m.password) throw new PermanentError('Email is not set up: address and app password are needed.');
  if (mailerOverride) return mailerOverride;
  return nodemailer.createTransport({ host: m.smtpHost, port: m.smtpPort, secure: m.smtpPort === 465, auth: { user: m.address, pass: m.password }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
}

/** Real check: SMTP login and IMAP login must both succeed. */
export async function verifyMailbox(ch) {
  const t = await smtp(ch);
  try { await t.verify(); } catch (e) { throw new Error(`Mail server refused the login (${e.message}). For Gmail use an App Password, not the normal password.`); }
  finally { t.close?.(); }
  if (mailerOverride) return;
  const client = await imap(ch);
  try { await client.connect(); await client.logout(); } catch (e) { throw new Error(`IMAP login failed (${e.message}). In Gmail: Settings → Forwarding and POP/IMAP → Enable IMAP.`); }
}

async function imap(ch) {
  const { ImapFlow } = await import('imapflow');
  const m = mailbox(ch);
  return new ImapFlow({ host: m.imapHost, port: 993, secure: true, auth: { user: m.address, pass: m.password }, logger: false, socketTimeout: 60000 });
}

// ---------- unsubscribe links (no login needed; token proves the link came from us) ----------
function unsubSecret() { return crypto.createHash('sha256').update('unsub:' + (config.encryptionKey || 'dev-only')).digest(); }
export function unsubscribeUrl(businessId, contactId) {
  const sig = crypto.createHmac('sha256', unsubSecret()).update(`${businessId}:${contactId}`).digest('base64url');
  return `${config.publicUrl}/api/public/unsubscribe/${businessId}/${contactId}/${sig}`;
}
export function verifyUnsubscribe(businessId, contactId, sig) {
  const want = crypto.createHmac('sha256', unsubSecret()).update(`${businessId}:${contactId}`).digest('base64url');
  return want.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(sig)));
}

const FOOTER = (sig, unsub, marketing) => `\n\n--\n${sig || ''}${marketing ? `\nDon't want these emails? Unsubscribe: ${unsub}` : ''}`;
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const htmlOf = text => `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222;white-space:pre-wrap">${esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`;

/** Send one email. Marketing emails carry the unsubscribe footer and List-Unsubscribe headers. */
export async function sendEmail(c, { to, subject, body, purpose = 'conversational', inReplyTo = null, businessId, contactId, signature = '' }) {
  const ch = await getChannel(c, 'email');
  if (ch.status !== 'connected') throw new PermanentError(`Email is not connected${ch.status === 'error' ? ` (${ch.last_error})` : ''}. Connect it in Settings → Channels.`);
  const m = mailbox(ch);
  const unsub = unsubscribeUrl(businessId, contactId);
  const text = body + FOOTER(signature, unsub, purpose === 'marketing');
  if (!deliveryIsLive() && !mailerOverride) return { status: 'sandbox', providerId: `<sandbox-${crypto.randomUUID()}@${m.address.split('@')[1]}>` };
  const t = await smtp(ch);
  try {
    const info = await t.sendMail({
      from: m.fromName ? { name: m.fromName, address: m.address } : m.address, to, subject: subject || '(no subject)', text, html: htmlOf(text),
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
      ...(purpose === 'marketing' ? { list: { unsubscribe: { url: unsub, comment: 'Unsubscribe' } }, headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    });
    const rejected = (info.rejected || []).length;
    if (rejected) throw new PermanentError(`The mail server rejected the address ${info.rejected.join(', ')}`);
    return { status: 'sent', providerId: info.messageId };
  } catch (e) {
    if (e instanceof PermanentError) throw e;
    const code = e.responseCode || 0;
    if (code === 535 || code === 534) throw new PermanentError(`Mailbox login failed: ${e.message}`);
    if (code >= 500 && code < 600) throw new PermanentError(`Mail server refused the message: ${e.message}`);
    throw new RetryableError(`Mail server not reachable: ${e.message}`);
  } finally { t.close?.(); }
}

// ---------- inbound: pull new mail every couple of minutes ----------
const SKIP_FROM = /(^|[.-])(no-?reply|noreply|mailer-daemon|postmaster|bounce|notifications?|newsletter|do-?not-?reply)@/i;

export async function pollMailbox(businessId, { client: injected = null, handle = null } = {}) {
  const ch = await withBiz(businessId, c => getChannel(c, 'email'));
  if (ch.status !== 'connected') return { skipped: 'not connected' };
  const self = mailbox(ch).address;
  const cur = (await withBiz(businessId, c => c.query('select * from email_sync where business_id = $1', [businessId]))).rows[0] || { last_uid: 0 };
  const client = injected || await imap(ch);
  const { simpleParser } = await import('mailparser');
  let imported = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const box = client.mailbox;
      let since = Number(cur.last_uid || 0);
      if (cur.uidvalidity && box.uidValidity && Number(cur.uidvalidity) !== Number(box.uidValidity)) since = 0;   // mailbox was recreated
      if (!since) {
        // first run: do not import the whole history, only what arrives from now on
        since = Number(box.uidNext || 1) - 1;
      } else {
        for await (const msg of client.fetch({ uid: `${since + 1}:*` }, { uid: true, source: true, envelope: true })) {
          if (msg.uid <= since) continue;
          since = Math.max(since, msg.uid);
          const parsed = await simpleParser(msg.source);
          const from = emailAddress(parsed.from?.value?.[0]?.address);
          if (!from || from === self || SKIP_FROM.test(from)) continue;
          if ((parsed.headers.get('auto-submitted') || '') !== '' && parsed.headers.get('auto-submitted') !== 'no') continue;   // auto-replies
          const text = (parsed.text || '').replace(/\r\n/g, '\n');
          const body = stripQuoted(text).trim() || (parsed.subject ? `(empty email) ${parsed.subject}` : '(empty email)');
          const fn = handle || defaultHandle;
          await fn(businessId, { from, name: parsed.from?.value?.[0]?.name || null, subject: parsed.subject || '', body, messageId: parsed.messageId || `<uid-${msg.uid}@${self}>`, inReplyTo: parsed.inReplyTo || null, date: parsed.date || new Date() });
          imported++;
        }
      }
      await withBiz(businessId, c => c.query(`insert into email_sync (business_id, last_uid, uidvalidity, last_polled_at, last_error) values ($1,$2,$3,now(),null)
        on conflict (business_id) do update set last_uid = $2, uidvalidity = $3, last_polled_at = now(), last_error = null`, [businessId, since, box.uidValidity ? Number(box.uidValidity) : null]));
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    try { await client.logout(); } catch { /* ignore */ }
    await withBiz(businessId, c => c.query(`insert into email_sync (business_id, last_polled_at, last_error) values ($1, now(), $2)
      on conflict (business_id) do update set last_polled_at = now(), last_error = $2`, [businessId, String(e.message).slice(0, 500)]));
    if (/auth|login|credentials/i.test(e.message)) await withBiz(businessId, c => setChannelStatus(c, 'email', 'error', `Mailbox login failed: ${e.message}`));
    throw new RetryableError(`Mailbox check failed: ${e.message}`);
  }
  return { imported };
}

/** Keeps only the new part of a reply (drops quoted history and signatures as best we can). */
export function stripQuoted(text) {
  const lines = String(text || '').split('\n'); const out = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) || /^From: .+$/.test(l.trim()) && out.length) break;
    if (/^>/.test(l)) continue;
    if (/^--\s*$/.test(l) || /^__+$/.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function defaultHandle(businessId, mail) {
  const { handleInbound } = await import('../services/messaging.js');
  await withBiz(businessId, c => handleInbound(c, { businessId }, { channel: 'email', thread: mail.from, name: mail.name, body: mail.subject ? `${mail.subject}\n\n${mail.body}` : mail.body, providerId: mail.messageId, source: 'email', extra: { subject: mail.subject, inReplyTo: mail.inReplyTo } }));
}

// ---------- jobs ----------
registerHandler('email.poll', async job => {
  const r = await pollMailbox(job.business_id);
  return { reschedule: 120, ...r };
});

/** Started by the worker: one poll job per business with a connected mailbox. */
export async function ensureEmailPolling() {
  const rows = (await withSystem(c => c.query(`select business_id from channel_accounts where channel = 'email' and status = 'connected'`))).rows;
  for (const { business_id } of rows) {
    await withSystem(c => c.query(`update jobs set status = 'pending', attempts = 0, run_at = now(), last_error = null where business_id = $1 and idempotency_key = 'email.poll' and status = 'dead'`, [business_id]));
    await withSystem(c => c.query(`insert into jobs (business_id, kind, payload, idempotency_key, run_at, max_attempts, created_at) values ($1,'email.poll','{}','email.poll', now(), 1000000, clock_timestamp())
      on conflict (business_id, idempotency_key) do nothing`, [business_id]));
  }
}
