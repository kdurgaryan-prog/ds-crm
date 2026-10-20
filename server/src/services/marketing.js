// Campaign lifecycle: Draft → Pending approval → Approved → (Scheduled) → Running/Published → Paused/Stopped/Completed.
import { sha256, stableStringify } from '../lib/crypto.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/http.js';
import { audit, logAgentAction } from './audit.js';
import { enqueue, registerHandler, PermanentError, RetryableError } from '../jobs/queue.js';
import { withBiz } from '../db.js';
import { getSettings } from './settings.js';
import { checkContactAllowed, withinCampaignHours } from './compliance.js';
import { upsertConversation, queueOutbound } from './messaging.js';
import { getChannel, GRAPH, deliveryMode } from '../integrations/channels.js';
import { signedMediaUrl } from './files.js';
import { DateTime } from 'luxon';

export const SENDING_KINDS = ['sms_blast', 'whatsapp_blast', 'call_campaign', 'email_blast'];
const channelOf = k => (k === 'call_campaign' ? 'voice' : k === 'sms_blast' ? 'sms' : k === 'email_blast' ? 'email' : 'whatsapp');

export const PUBLISH_KINDS = ['social_post'];

export async function getCampaign(c, id) {
  const r = (await c.query('select * from campaigns where id = $1', [id])).rows[0];
  if (!r) throw notFound('Campaign not found.');
  return r;
}

/** Audience filter → contact ids (only fields marketing is allowed to filter by). */
export async function resolveAudience(c, audience = {}) {
  const where = ['deleted_at is null', 'merged_into is null']; const vals = [];
  const add = (col, arr) => { if (arr?.length) { vals.push(arr); where.push(`${col} = any($${vals.length})`); } };
  add('status', audience.statuses); add('industry', audience.industries); add('source', audience.sources); add('product_type', audience.productTypes);
  add('county', audience.counties); add('city', audience.cities); add('industry_type', audience.industryTypes);
  if (audience.contactIds?.length) { vals.push(audience.contactIds); where.push(`id = any($${vals.length})`); }
  const { rows } = await c.query(`select * from contacts where ${where.join(' and ')} order by lead_no limit 5000`, vals);
  return rows;
}

/** Everything the owner sees and approves. The hash makes sure exactly this is what runs. */
export async function approvalPreview(c, ctx, campaign) {
  const s = await getSettings(c, ctx.businessId);
  const content = campaign.content || {};
  const fileIds = (content.files || []).map(f => f.id).filter(Boolean);
  const files = fileIds.length ? (await c.query('select id, filename, mime, contact_id, marketing_permission from files where id = any($1) order by filename', [fileIds])).rows : [];
  const preview = { kind: campaign.kind, title: campaign.title, text: content.text || null, files: files.map(f => ({ id: f.id, filename: f.filename, mime: f.mime })), channels: content.channels || [],
    scheduleAt: content.schedule_at || null, templateSid: content.template_sid || null, templateVariables: content.template_variables || null, audience: content.audience || null };
  const warnings = [...(content.warnings || [])];
  // hash covers what was decided (text, files, channels, audience rule, time), not live counts that change daily
  const hash = sha256(stableStringify(preview));
  if (SENDING_KINDS.includes(campaign.kind)) {
    const people = await resolveAudience(c, content.audience);
    const channel = channelOf(campaign.kind);
    let allowed = 0; const skipped = {};
    for (const p of people) {
      const chk = checkContactAllowed({ contact: p, purpose: 'marketing', channel, hours: { ...s.campaignHours, days: null, start: '00:00', end: '23:59' }, aiVoice: channel === 'voice' });
      if (channel !== 'email' && !p.phone_e164) { skipped['No phone number'] = (skipped['No phone number'] || 0) + 1; continue; }
      if (chk.allowed) allowed++; else for (const r of chk.reasons) skipped[r] = (skipped[r] || 0) + 1;
    }
    preview.audienceSummary = { matched: people.length, eligible: allowed, skipped, sample: people.slice(0, 8).map(p => ({ lead_no: p.lead_no, name: p.name, company: p.company })) };
    preview.sendingHours = channel === 'email' ? `Up to ${s.email.dailyLimit} emails a day, one every ${s.email.secondsBetween} seconds (keeps the mailbox off spam lists)` : `${s.campaignHours.start}–${s.campaignHours.end} ${s.campaignHours.timezone}, and inside each recipient's local hours`;
    if (campaign.kind === 'email_blast' && !content.subject) warnings.push('Email needs a subject line.');
    if (campaign.kind === 'email_blast') preview.subject = content.subject || null;
    if (campaign.kind === 'whatsapp_blast' && !content.template_sid) warnings.push('WhatsApp marketing needs an approved template (Template SID).');
    if (campaign.kind === 'call_campaign') warnings.push('Natalie will place AI calls. Only contacts with written call consent on file will be called.');
  }
  for (const f of files) {
    if (f.contact_id && f.marketing_permission !== 'granted') warnings.push(`File "${f.filename}" belongs to a customer without marketing permission.`);
  }
  if (fileIds.length !== files.length) warnings.push('Some attached files no longer exist.');
  return { preview, warnings, hash };
}

export async function createCampaign(c, ctx, { kind, title, content, agent = null }) {
  const r = (await c.query(`insert into campaigns (business_id, kind, title, content, created_by, created_by_agent) values ($1,$2,$3,$4,$5,$6) returning *`,
    [ctx.businessId, kind, title, content || {}, ctx.userId || null, agent])).rows[0];
  await audit(c, ctx, 'campaign.create', 'campaign', r.id, null, { kind, title });
  return r;
}

export async function updateCampaign(c, ctx, id, { title, content }) {
  const cur = await getCampaign(c, id);
  if (['running', 'published', 'completed'].includes(cur.status)) throw conflict('This campaign has already run and can no longer be edited.', { hint: 'Duplicate it to make a new version.' });
  // any edit sends it back to Draft and clears the approval
  const r = (await c.query(`update campaigns set title = coalesce($2, title), content = coalesce($3, content), status = 'draft',
                             approval_hash = null, approved_by = null, approved_at = null, updated_at = now() where id = $1 returning *`, [id, title ?? null, content ?? null])).rows[0];
  await audit(c, ctx, 'campaign.update', 'campaign', id, { status: cur.status }, { status: 'draft' });
  return r;
}

export async function submitForApproval(c, ctx, id) {
  const cur = await getCampaign(c, id);
  if (cur.status !== 'draft' && cur.status !== 'rejected') throw conflict(`Only drafts can be submitted (current: ${cur.status}).`);
  const r = (await c.query(`update campaigns set status = 'pending_approval', updated_at = now() where id = $1 returning *`, [id])).rows[0];
  await audit(c, ctx, 'campaign.submit', 'campaign', id);
  return r;
}

export async function approveCampaign(c, ctx, id, { hash }) {
  if (ctx.role !== 'owner') throw forbidden('Only the owner can approve publishing, blasts and call campaigns.');
  const cur = await getCampaign(c, id);
  if (cur.status !== 'pending_approval') throw conflict('Submit the campaign for approval first.');
  const { hash: now } = await approvalPreview(c, ctx, cur);
  if (hash !== now) throw conflict('The campaign changed since you opened the preview.', { hint: 'Reopen the preview and review the latest version.' });
  const r = (await c.query(`update campaigns set status = 'approved', approval_hash = $2, approved_by = $3, approved_at = now(), updated_at = now() where id = $1 returning *`, [id, now, ctx.userId])).rows[0];
  await audit(c, ctx, 'campaign.approve', 'campaign', id, null, { hash: now });
  if (cur.created_by_agent) await logAgentAction(c, ctx.businessId, { agent: cur.created_by_agent, action: 'campaign_approved', basedOn: { campaignId: id }, approvalRequired: true, approvalStatus: 'approved', result: 'ok' });
  return r;
}

export async function rejectCampaign(c, ctx, id, note) {
  const cur = await getCampaign(c, id);
  if (cur.status !== 'pending_approval') throw conflict('Only campaigns waiting for approval can be rejected.');
  const r = (await c.query(`update campaigns set status = 'rejected', result = result || $2, updated_at = now() where id = $1 returning *`, [id, { rejectNote: note || null }])).rows[0];
  await audit(c, ctx, 'campaign.reject', 'campaign', id, null, { note });
  if (cur.created_by_agent) await logAgentAction(c, ctx.businessId, { agent: cur.created_by_agent, action: 'campaign_rejected', basedOn: { campaignId: id }, approvalRequired: true, approvalStatus: 'rejected', result: 'ok', detail: note });
  return r;
}

/** Start/publish. Requires owner approval of the exact current content. */
export async function startCampaign(c, ctx, id) {
  const cur = await getCampaign(c, id);
  if (!['approved', 'paused'].includes(cur.status)) throw conflict(cur.status === 'pending_approval' ? 'Waiting for owner approval.' : `Cannot start a campaign that is ${cur.status}.`);
  const { hash } = await approvalPreview(c, ctx, cur);
  if (hash !== cur.approval_hash && cur.status === 'approved') throw conflict('The content or audience changed after approval. It needs to be approved again.');
  const s = await getSettings(c, ctx.businessId);
  if (cur.kind === 'call_campaign' && (!s.agents.natalie.enabled || !s.agents.natalie.outboundCalls)) throw conflict('Natalie outbound calls are turned off.', { hint: 'Turn them on in AI Agents → Natalie.' });
  const runAt = cur.content?.schedule_at && new Date(cur.content.schedule_at) > new Date() ? new Date(cur.content.schedule_at) : null;
  if (PUBLISH_KINDS.includes(cur.kind)) {
    await enqueue(c, ctx.businessId, 'campaign.publish', { campaignId: id }, { key: `publish:${id}`, runAt, maxAttempts: 4 });
  } else if (SENDING_KINDS.includes(cur.kind)) {
    if (cur.status === 'approved') {
      const people = await resolveAudience(c, cur.content.audience);
      for (const p of people) await c.query(`insert into campaign_recipients (business_id, campaign_id, contact_id) values ($1,$2,$3) on conflict do nothing`, [ctx.businessId, id, p.id]);
    }
    await enqueue(c, ctx.businessId, 'campaign.tick', { campaignId: id }, { key: `tick:${id}:${Date.now()}`, runAt });
  } else {
    throw badRequest('This item is content only (nothing to send). Mark it as used instead.');
  }
  const r = (await c.query(`update campaigns set status = $2, updated_at = now() where id = $1 returning *`, [id, runAt ? 'scheduled' : 'running'])).rows[0];
  await audit(c, ctx, 'campaign.start', 'campaign', id);
  return r;
}

export async function controlCampaign(c, ctx, id, action) {
  const cur = await getCampaign(c, id);
  const to = { pause: 'paused', stop: 'stopped' }[action];
  if (!to) throw badRequest('Unknown action.');
  if (!['running', 'scheduled', 'paused'].includes(cur.status)) throw conflict(`Campaign is ${cur.status}.`);
  const r = (await c.query(`update campaigns set status = $2, updated_at = now() where id = $1 returning *`, [id, to])).rows[0];
  if (to === 'stopped') await c.query(`update campaign_recipients set status = 'skipped', skip_reason = 'Campaign stopped' where campaign_id = $1 and status = 'pending'`, [id]);
  await c.query(`update jobs set status = 'canceled' where status = 'pending' and payload->>'campaignId' = $1`, [id]);
  await audit(c, ctx, `campaign.${action}`, 'campaign', id);
  return r;
}

// ---------- jobs ----------
registerHandler('campaign.publish', async job => withBiz(job.business_id, async c => {
  const camp = await getCampaign(c, job.payload.campaignId);
  if (!['running', 'scheduled', 'failed'].includes(camp.status)) return {};
  const ctx = { businessId: job.business_id, role: 'owner' };
  const { hash, preview } = await approvalPreview(c, ctx, { ...camp, status: 'approved' });
  if (hash !== camp.approval_hash) throw new PermanentError('Content differs from what the owner approved. Not published.');
  const prior = camp.result?.publish || {};
  const results = {};
  for (const ch of camp.content.channels || []) {
    if (prior[ch]?.ok && !prior[ch]?.sandbox) { results[ch] = prior[ch]; continue; } // already posted — never post twice
    const acct = await getChannel(c, ch);
    if (acct.status !== 'connected') { results[ch] = { ok: false, error: `${ch} not connected` }; continue; }
    if (deliveryMode() !== 'live') { results[ch] = { ok: true, sandbox: true }; continue; }
    const imgFile = preview.files.find(f => (f.mime || '').startsWith('image/'));
    const imageUrl = imgFile ? signedMediaUrl(job.business_id, imgFile.id, 3600 * 6) : null;
    const token = encodeURIComponent(acct.secrets.pageAccessToken);
    try {
      if (ch === 'messenger') { // Facebook Page post
        const url = imageUrl ? `${GRAPH}/${acct.config.pageId}/photos` : `${GRAPH}/${acct.config.pageId}/feed`;
        const body = imageUrl ? { url: imageUrl, caption: camp.content.text } : { message: camp.content.text };
        const r = await fetch(`${url}?access_token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
        results[ch] = { ok: true, id: j.post_id || j.id };
      } else if (ch === 'instagram') {
        if (!imageUrl) throw new Error('Instagram posts need an image');
        const r1 = await fetch(`${GRAPH}/${acct.config.igAccountId}/media?access_token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image_url: imageUrl, caption: camp.content.text }) });
        const j1 = await r1.json(); if (!r1.ok) throw new Error(j1.error?.message || `HTTP ${r1.status}`);
        const r2 = await fetch(`${GRAPH}/${acct.config.igAccountId}/media_publish?access_token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creation_id: j1.id }) });
        const j2 = await r2.json(); if (!r2.ok) throw new Error(j2.error?.message || `HTTP ${r2.status}`);
        results[ch] = { ok: true, id: j2.id };
      } else results[ch] = { ok: false, error: 'Publishing to this channel is not supported' };
    } catch (e) { results[ch] = { ok: false, error: e.message }; }
  }
  const allOk = Object.values(results).length > 0 && Object.values(results).every(r => r.ok);
  const sandbox = Object.values(results).some(r => r.sandbox);
  await c.query(`update campaigns set status = $2, result = result || $3, updated_at = now() where id = $1`,
    [camp.id, allOk ? (sandbox ? 'completed' : 'published') : 'failed', { publish: results, mode: sandbox ? 'sandbox (not actually published)' : 'live', at: new Date().toISOString() }]);
  if (camp.created_by_agent) await logAgentAction(c, job.business_id, { agent: camp.created_by_agent, action: 'publish', basedOn: { campaignId: camp.id }, approvalRequired: true, approvalStatus: 'approved', change: results, result: allOk ? 'ok' : 'error' });
  await c.query('commit'); await c.query('begin'); // keep the record of what was posted, even when another channel failed
  if (!allOk) throw new PermanentError(`Publishing failed: ${Object.entries(results).filter(([, r]) => !r.ok).map(([k, r]) => `${k}: ${r.error}`).join('; ')}`);
  return {};
}));

function nextWindowStart(hours, now = new Date()) {
  let d = DateTime.fromJSDate(now).setZone(hours.timezone);
  const [h, m] = hours.start.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const cand = d.set({ hour: h, minute: m, second: 0, millisecond: 0 }).plus({ days: i });
    if (cand > DateTime.fromJSDate(now) && (!hours.days || hours.days.includes(cand.weekday))) return cand.toJSDate();
  }
  return new Date(now.getTime() + 3600_000);
}

registerHandler('campaign.tick', async job => withBiz(job.business_id, async c => {
  const camp = await getCampaign(c, job.payload.campaignId);
  if (camp.status === 'scheduled') await c.query(`update campaigns set status = 'running' where id = $1`, [camp.id]);
  else if (camp.status !== 'running') return {};
  const s = await getSettings(c, job.business_id);
  const ctx = { businessId: job.business_id, role: 'owner' };
  const { hash } = await approvalPreview(c, ctx, { ...camp, status: 'approved' });
  if (hash !== camp.approval_hash) {
    await c.query(`update campaigns set status = 'paused', result = result || '{"pausedReason":"Changed after approval"}' where id = $1`, [camp.id]);
    return {};
  }
  const channel = channelOf(camp.kind);
  if (channel !== 'email' && !withinCampaignHours({ ...s.campaignHours }, null).ok) {
    return { reschedule: Math.max(60, Math.round((nextWindowStart(s.campaignHours) - Date.now()) / 1000)) };
  }
  if (channel === 'email') {
    const sentToday = (await c.query(`select count(*)::int n from messages where channel = 'email' and direction = 'out' and purpose = 'marketing' and status in ('sent','sending','queued','sandbox') and created_at >= (date_trunc('day', now() at time zone $1) at time zone $1)`, [s.campaignHours.timezone])).rows[0].n;
    if (sentToday >= s.email.dailyLimit) return { reschedule: 1800 };   // today's limit reached: look again in 30 minutes
  }
  if (channel === 'voice') {
    if (!s.agents.natalie.enabled || !s.agents.natalie.outboundCalls) {
      await c.query(`update campaigns set status = 'paused', result = result || '{"pausedReason":"Natalie outbound calls turned off"}' where id = $1`, [camp.id]);
      return {};
    }
    const active = (await c.query(`select 1 from calls where campaign_id = $1 and status in ('initiated','ringing','in-progress')`, [camp.id])).rowCount;
    if (active) return { reschedule: 20 };
  }
  const batch = (await c.query(`select r.contact_id from campaign_recipients r where r.campaign_id = $1 and r.status = 'pending' order by r.updated_at, r.contact_id limit $2`, [camp.id, channel === 'voice' || channel === 'email' ? 1 : 25])).rows;
  if (!batch.length) {
    await c.query(`update campaigns set status = 'completed', updated_at = now() where id = $1`, [camp.id]);
    return {};
  }
  for (const { contact_id } of batch) {
    const contact = (await c.query('select * from contacts where id = $1', [contact_id])).rows[0];
    const dnc = contact.phone_e164 ? (await c.query('select 1 from dnc_numbers where phone_e164 = $1', [contact.phone_e164])).rowCount > 0 : false;
    const chk = checkContactAllowed({ contact, dncListed: dnc, purpose: 'marketing', channel, hours: s.campaignHours, aiVoice: channel === 'voice' });
    if (channel !== 'email' && !contact.phone_e164) chk.allowed = false, chk.reasons.push('No phone number');
    if (!chk.allowed) {
      const outsideHoursOnly = chk.reasons.every(r => /Outside|timezone unknown/.test(r));
      await c.query(`update campaign_recipients set status = $3, skip_reason = $4, updated_at = now() where campaign_id = $1 and contact_id = $2`,
        [camp.id, contact_id, outsideHoursOnly ? 'pending' : 'skipped', chk.reasons.join('; ')]);
      if (outsideHoursOnly) continue;
      continue;
    }
    if (channel === 'voice') {
      await enqueue(c, job.business_id, 'call.outbound_ai', { campaignId: camp.id, contactId: contact_id }, { key: `aicall:${camp.id}:${contact_id}`, maxAttempts: 1 });
      await c.query(`update campaign_recipients set status = 'queued', updated_at = now() where campaign_id = $1 and contact_id = $2`, [camp.id, contact_id]);
    } else {
      const held = (await c.query(`select id from messages where idempotency_key = $1 and status = 'blocked'`, [`camp:${camp.id}:${contact_id}`])).rows[0];
      if (held) { // held back earlier (paused / outside hours): send that same message now
        await c.query(`update messages set status = 'queued', status_detail = null where id = $1`, [held.id]);
        await enqueue(c, job.business_id, 'message.send', { messageId: held.id, template: channel === 'whatsapp' ? { contentSid: camp.content.template_sid, variables: camp.content.template_variables || undefined } : null }, { key: `send:${held.id}:${Date.now()}` });
        await c.query(`update campaign_recipients set status = 'queued', skip_reason = null, updated_at = now() where campaign_id = $1 and contact_id = $2`, [camp.id, contact_id]);
        continue;
      }
      const conv = await upsertConversation(c, ctx, { contactId: contact_id, channel, thread: channel === 'email' ? contact.email.toLowerCase() : contact.phone_e164 });
      const template = channel === 'whatsapp' ? { contentSid: camp.content.template_sid, variables: camp.content.template_variables || undefined } : null;
      const { fillTemplate } = await import('./intro.js');
      const msg = await queueOutbound(c, ctx, { conversation: conv, body: channel === 'email' ? fillTemplate(camp.content.text, contact) : camp.content.text, subject: channel === 'email' ? fillTemplate(camp.content.subject, contact) : null, authorType: 'system', purpose: 'marketing', key: `camp:${camp.id}:${contact_id}`, template });
      await c.query(`update campaign_recipients set status = $3, skip_reason = $4, updated_at = now() where campaign_id = $1 and contact_id = $2`,
        [camp.id, contact_id, msg.status === 'blocked' ? 'skipped' : 'queued', msg.status === 'blocked' ? msg.status_detail : null]);
    }
  }
  // recipients only blocked by local hours stay pending; if everyone left is in that state, wait
  return { reschedule: channel === 'voice' ? 20 : channel === 'email' ? s.email.secondsBetween : 30 };
}));
