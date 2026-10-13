// Meta (Messenger + Instagram Direct) webhooks with X-Hub-Signature-256 verification.
import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { withSystem, withBiz } from '../db.js';
import { getChannel, GRAPH } from './channels.js';
import { handleInbound } from '../services/messaging.js';
import { routeBusiness } from './twilio-webhooks.js';

const router = Router();
// keep the raw body for signature verification
router.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

export function metaSignatureValid(rawBody, header, appSecret) {
  if (!header || !appSecret || !rawBody) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return want.length === header.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(header));
}

// Subscription handshake: verify token must match a business's configured token.
router.get('/', async (req, res) => {
  const mode = req.query['hub.mode']; const token = req.query['hub.verify_token']; const challenge = req.query['hub.challenge'];
  if (mode !== 'subscribe' || !token) return res.sendStatus(403);
  const ids = await withSystem(async c => (await c.query(`select distinct business_id from channel_routes where provider in ('fb_page','ig_account')`)).rows.map(r => r.business_id));
  for (const id of ids) {
    const ok = await withBiz(id, async c => {
      for (const ch of ['messenger', 'instagram']) { const a = await getChannel(c, ch); if (a.secrets?.verifyToken && a.secrets.verifyToken === token) return true; }
      return false;
    });
    if (ok) return res.type('text/plain').send(String(challenge));
  }
  res.sendStatus(403);
});

async function profileName(c, channel, psid) {
  try {
    const a = await getChannel(c, channel);
    const r = await fetch(`${GRAPH}/${psid}?fields=${channel === 'instagram' ? 'name,username' : 'first_name,last_name'}&access_token=${encodeURIComponent(a.secrets.pageAccessToken)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.name || [j.first_name, j.last_name].filter(Boolean).join(' ') || j.username || null;
  } catch { return null; }
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  const isIg = body.object === 'instagram';
  const channel = isIg ? 'instagram' : 'messenger';
  // Respond fast; Meta retries on non-200. Each entry is verified against its business' app secret.
  for (const entry of body.entry || []) {
    const businessId = await routeBusiness(isIg ? 'ig_account' : 'fb_page', String(entry.id));
    if (!businessId) continue;
    const secret = await withBiz(businessId, async c => (await getChannel(c, channel)).secrets?.appSecret);
    if (!metaSignatureValid(req.rawBody, req.get('x-hub-signature-256'), secret)) return res.sendStatus(403);
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_echo) continue;               // our own sends come back as echoes
      const mid = m.mid;
      const psid = String(ev.sender.id);
      const media = (m.attachments || []).filter(a => a.payload?.url).map(a => ({ url: a.payload.url, mime: a.type === 'image' ? 'image/jpeg' : a.type }));
      await withBiz(businessId, async c => {
        const fresh = (await c.query(`insert into webhook_events (provider, event_id, business_id) values ('meta', $1, $2) on conflict do nothing returning 1`, [mid, businessId])).rowCount;
        if (!fresh) return; // same transaction as processing: a failure lets Meta's retry through
        const known = (await c.query(`select 1 from contact_identities where kind = $1 and value = $2`, [channel, psid])).rowCount;
        const name = known ? null : await profileName(c, channel, psid);
        await handleInbound(c, { businessId }, { channel, thread: psid, name, body: m.text || '', media, providerId: mid, source: channel });
        await c.query(`update channel_accounts set status = 'connected', last_error = null, last_checked_at = now() where channel = $1 and secrets_enc is not null`, [channel]);
      });
    }
  }
  res.sendStatus(200);
});

export default router;
