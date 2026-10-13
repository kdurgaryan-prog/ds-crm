// Channel accounts: credentials (encrypted), real connection status, routing of inbound addresses.
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { config, deliveryIsLive } from '../config.js';
import { badRequest } from '../lib/http.js';

export const CHANNELS = {
  sms: { label: 'SMS & MMS (Twilio)', secrets: ['accountSid', 'authToken'], config: ['phoneNumber', 'messagingServiceSid'] },
  voice: { label: 'Phone calls (Twilio)', secrets: ['accountSid', 'authToken', 'apiKeySid', 'apiKeySecret'], config: ['phoneNumber', 'twimlAppSid'] },
  whatsapp: { label: 'WhatsApp (Twilio)', secrets: ['accountSid', 'authToken'], config: ['whatsappNumber'] },
  messenger: { label: 'Facebook Messenger', secrets: ['pageAccessToken', 'appSecret', 'verifyToken'], config: ['pageId'] },
  instagram: { label: 'Instagram Direct', secrets: ['pageAccessToken', 'appSecret', 'verifyToken'], config: ['igAccountId', 'pageId'] },
  webchat: { label: 'Website chat', secrets: [], config: [] },
  website_forms: { label: 'Website quote & contact forms', secrets: [], config: [] },
  ai: { label: 'AI (Claude)', secrets: [], config: [] },
  shopify: { label: 'Shopify store', secrets: ['adminToken', 'webhookSecret'], config: ['shopDomain'] },
};

export const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;

export async function getChannel(c, channel) {
  const row = (await c.query('select * from channel_accounts where channel = $1', [channel])).rows[0];
  if (!row) return { channel, status: 'needs_setup', config: {}, secrets: {} };
  let secrets = {};
  try { secrets = row.secrets_enc ? decryptJson(row.secrets_enc) : {}; } catch { return { ...row, status: 'error', last_error: 'Stored credentials cannot be decrypted (server key changed?)', secrets: {} }; }
  return { ...row, secrets };
}

export async function saveChannel(c, businessId, channel, { config: cfg = {}, secrets = {} }) {
  if (!CHANNELS[channel]) throw badRequest('Unknown channel.');
  const cur = await getChannel(c, channel);
  const mergedSecrets = { ...cur.secrets };
  for (const k of CHANNELS[channel].secrets) if (secrets[k]) mergedSecrets[k] = secrets[k];
  const mergedCfg = { ...(cur.config || {}), ...Object.fromEntries(Object.entries(cfg).filter(([k]) => CHANNELS[channel].config.includes(k))) };
  await c.query(
    `insert into channel_accounts (business_id, channel, status, config, secrets_enc, last_error, last_checked_at)
     values ($1,$2,'needs_setup',$3,$4,null,null)
     on conflict (business_id, channel) do update set config = excluded.config, secrets_enc = excluded.secrets_enc, status = 'needs_setup', last_error = null`,
    [businessId, channel, mergedCfg, Object.keys(mergedSecrets).length ? encryptJson(mergedSecrets) : null]);
  // routing for inbound webhooks
  const routes = [];
  if (channel === 'sms' && mergedCfg.phoneNumber) routes.push(['twilio_number', mergedCfg.phoneNumber]);
  if (channel === 'voice' && mergedCfg.phoneNumber) routes.push(['twilio_number', mergedCfg.phoneNumber]);
  if (channel === 'whatsapp' && mergedCfg.whatsappNumber) routes.push(['whatsapp_number', mergedCfg.whatsappNumber]);
  if (channel === 'messenger' && mergedCfg.pageId) routes.push(['fb_page', mergedCfg.pageId]);
  if (channel === 'instagram' && mergedCfg.igAccountId) routes.push(['ig_account', mergedCfg.igAccountId]);
  if (channel === 'shopify' && mergedCfg.shopDomain) routes.push(['shopify_domain', mergedCfg.shopDomain]);
  return routes;
}

export async function setChannelStatus(c, channel, status, error = null) {
  await c.query(`insert into channel_accounts (business_id, channel, status, last_error, last_checked_at)
                 values (app_biz(), $1, $2, $3, now())
                 on conflict (business_id, channel) do update set status = $2, last_error = $3, last_checked_at = now()`, [channel, status, error]);
}

/** Real verification against the provider. Never marks "connected" without a successful API response. */
export async function verifyChannel(c, channel, { fetchImpl = fetch } = {}) {
  const ch = await getChannel(c, channel);
  const need = (CHANNELS[channel]?.secrets || []).filter(k => !ch.secrets[k]);
  const needCfg = (CHANNELS[channel]?.config || []).filter(k => !ch.config?.[k] && !(channel === 'sms' && k === 'messagingServiceSid') && !(channel === 'voice' && k === 'twimlAppSid'));
  if (channel === 'ai') {
    if (!config.anthropicApiKey) { await setChannelStatus(c, 'ai', 'needs_setup', 'ANTHROPIC_API_KEY is not set on the server'); return 'needs_setup'; }
  } else if (channel === 'webchat' || channel === 'website_forms') {
    // Connected only once the website has actually sent something (set by the public endpoints).
    return ch.status;
  } else if (need.length || needCfg.length) {
    await setChannelStatus(c, channel, 'needs_setup', `Missing: ${[...need, ...needCfg].join(', ')}`);
    return 'needs_setup';
  }
  try {
    if (['sms', 'voice', 'whatsapp'].includes(channel)) {
      const auth = Buffer.from(`${ch.secrets.accountSid}:${ch.secrets.authToken}`).toString('base64');
      const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${ch.secrets.accountSid}.json`, { headers: { Authorization: `Basic ${auth}` } });
      if (!r.ok) throw new Error(`Twilio rejected the credentials (HTTP ${r.status})`);
      const acct = await r.json();
      if (acct.status !== 'active') throw new Error(`Twilio account is ${acct.status}`);
    } else if (channel === 'messenger' || channel === 'instagram') {
      const id = channel === 'messenger' ? ch.config.pageId : ch.config.igAccountId;
      const r = await fetchImpl(`${GRAPH}/${id}?fields=id,name${channel === 'instagram' ? ',username' : ''}&access_token=${encodeURIComponent(ch.secrets.pageAccessToken)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Meta: ${j.error?.message || `HTTP ${r.status}`}`);
    } else if (channel === 'ai') {
      const r = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' } });
      if (!r.ok) throw new Error(`Anthropic API key rejected (HTTP ${r.status})`);
    } else if (channel === 'shopify') {
      const r = await fetchImpl(`https://${ch.config.shopDomain}/admin/api/2025-07/shop.json`, { headers: { 'X-Shopify-Access-Token': ch.secrets.adminToken } });
      if (!r.ok) throw new Error(`Shopify rejected the token (HTTP ${r.status})`);
    }
    await setChannelStatus(c, channel, 'connected', null);
    return 'connected';
  } catch (e) {
    await setChannelStatus(c, channel, 'error', e.message);
    return 'error';
  }
}

export function deliveryMode() { return deliveryIsLive() ? 'live' : 'sandbox'; }
