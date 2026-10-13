import { Router } from 'express';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, notFound } from '../lib/http.js';
import { createCampaign, updateCampaign, submitForApproval, approveCampaign, rejectCampaign, startCampaign, controlCampaign, approvalPreview, getCampaign } from '../services/marketing.js';
import { arevDraft, arevSuggestions } from '../agents/arev.js';

const r = Router();
const KINDS = ['social_post', 'ad_copy', 'sms_blast', 'whatsapp_blast', 'call_campaign', 'image_prompt', 'video_script', 'content_calendar'];
const content = z.object({
  text: z.string().max(20000).optional(), channels: z.array(z.enum(['messenger', 'instagram', 'sms', 'whatsapp', 'voice'])).optional(),
  audience: z.object({ statuses: z.array(z.string()).optional(), industries: z.array(z.string()).optional(), sources: z.array(z.string()).optional(), productTypes: z.array(z.string()).optional(), contactIds: z.array(z.string().uuid()).optional() }).nullish(),
  schedule_at: z.string().datetime({ offset: true }).nullish(), template_sid: z.string().max(64).nullish(), template_variables: z.record(z.string(), z.string()).nullish(),
  files: z.array(z.object({ id: z.string().uuid(), filename: z.string(), mime: z.string().nullish(), contact_id: z.string().uuid().nullish(), marketing_permission: z.string().nullish() })).optional(),
  brief: z.string().max(2000).nullish(), warnings: z.array(z.string()).optional(),
}).passthrough();

r.get('/', requirePerm('marketing.read'), async (req, res) => {
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(
    `select cp.*, u.name approved_by_name,
       (select count(*) from campaign_recipients r where r.campaign_id = cp.id)::int recipients,
       (select count(*) from campaign_recipients r where r.campaign_id = cp.id and r.status in ('sent','queued','called','sandbox'))::int reached,
       (select count(*) from campaign_recipients r where r.campaign_id = cp.id and r.status = 'skipped')::int skipped
     from campaigns cp left join users u on u.id = cp.approved_by
     ${req.query.status ? 'where cp.status = any($1)' : ''} order by cp.updated_at desc limit 300`, req.query.status ? [String(req.query.status).split(',')] : [])).rows);
  res.json(rows);
});

r.get('/suggestions', requirePerm('marketing.read'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, c => arevSuggestions(c, req.ctx)));
});

r.post('/', requirePerm('marketing.write'), async (req, res) => {
  const b = parse(z.object({ kind: z.enum(KINDS), title: z.string().min(1).max(160), content: content.default({}) }), req.body);
  res.status(201).json(await withBiz(req.ctx.businessId, c => createCampaign(c, req.ctx, b)));
});

r.post('/arev', requirePerm('marketing.write'), async (req, res) => {
  const b = parse(z.object({ kind: z.enum(KINDS), brief: z.string().max(2000).optional(), channels: z.array(z.string()).default([]), audience: content.shape.audience, scheduleAt: z.string().nullish() }), req.body);
  res.status(201).json(await withBiz(req.ctx.businessId, c => arevDraft(c, req.ctx, b)));
});

r.get('/:id', requirePerm('marketing.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const cp = await getCampaign(c, req.params.id);
    const recipients = (await c.query(`select r.status, r.skip_reason, c.lead_no, c.name, c.company from campaign_recipients r join contacts c on c.id = r.contact_id where r.campaign_id = $1 order by r.updated_at desc limit 300`, [cp.id])).rows;
    const counts = (await c.query(`select status, count(*)::int n from campaign_recipients where campaign_id = $1 group by 1`, [cp.id])).rows;
    return { ...cp, recipients, counts };
  });
  res.json(out);
});

r.get('/:id/preview', requirePerm('marketing.read'), async (req, res) => {
  res.json(await withBiz(req.ctx.businessId, async c => approvalPreview(c, req.ctx, await getCampaign(c, req.params.id))));
});

r.patch('/:id', requirePerm('marketing.write'), async (req, res) => {
  const b = parse(z.object({ title: z.string().min(1).max(160).optional(), content: content.optional() }), req.body);
  res.json(await withBiz(req.ctx.businessId, c => updateCampaign(c, req.ctx, req.params.id, b)));
});

r.post('/:id/submit', requirePerm('marketing.write'), async (req, res) => res.json(await withBiz(req.ctx.businessId, c => submitForApproval(c, req.ctx, req.params.id))));
r.post('/:id/approve', requirePerm('marketing.approve'), async (req, res) => {
  const { hash } = parse(z.object({ hash: z.string().length(64) }), req.body);
  res.json(await withBiz(req.ctx.businessId, c => approveCampaign(c, req.ctx, req.params.id, { hash })));
});
r.post('/:id/reject', requirePerm('marketing.approve'), async (req, res) => res.json(await withBiz(req.ctx.businessId, c => rejectCampaign(c, req.ctx, req.params.id, req.body?.note))));
r.post('/:id/start', requirePerm('campaign.control'), async (req, res) => res.json(await withBiz(req.ctx.businessId, c => startCampaign(c, req.ctx, req.params.id))));
r.post('/:id/pause', requirePerm('campaign.control'), async (req, res) => res.json(await withBiz(req.ctx.businessId, c => controlCampaign(c, req.ctx, req.params.id, 'pause'))));
r.post('/:id/stop', requirePerm('campaign.control'), async (req, res) => res.json(await withBiz(req.ctx.businessId, c => controlCampaign(c, req.ctx, req.params.id, 'stop'))));
r.delete('/:id', requirePerm('marketing.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => {
    const cp = await getCampaign(c, req.params.id);
    if (!['draft', 'rejected'].includes(cp.status)) throw notFound('Only drafts can be deleted.');
    await c.query('delete from campaigns where id = $1', [cp.id]);
  });
  res.json({ ok: true });
});

export default r;
