import { Router } from 'express';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse } from '../lib/http.js';
import { getSettings, patchSettings } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { llmAvailable } from '../agents/llm.js';
import { buildSystemPrompt } from '../agents/natalie.js';

const r = Router();

r.get('/', requirePerm('agents.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const s = await getSettings(c, req.ctx.businessId);
    const stats = (await c.query(`select agent, result, count(*)::int n from agent_actions where created_at > now() - interval '7 days' group by 1,2`)).rows;
    const pending = (await c.query(`select count(*)::int n from campaigns where status = 'pending_approval'`)).rows[0].n;
    const pendingQuotes = (await c.query(`select count(*)::int n from quotes where created_by_agent is not null and status in ('draft','pending_approval')`)).rows[0].n;
    const aiConversations = (await c.query(`select count(*) filter (where ai_enabled)::int ai_on, count(*) filter (where not ai_enabled and status <> 'done')::int paused from conversations`)).rows[0];
    return { natalie: s.agents.natalie, arev: s.agents.arev, aiConfigured: llmAvailable(), stats, pendingApprovals: pending, pendingQuotes, aiConversations };
  });
  res.json(out);
});

r.get('/actions', requirePerm('agents.read'), async (req, res) => {
  const { agent, result } = req.query;
  const where = []; const vals = [];
  if (agent) { vals.push(agent); where.push(`agent = $${vals.length}`); }
  if (result) { vals.push(result); where.push(`result = $${vals.length}`); }
  const page = Math.max(1, Number(req.query.page || 1));
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(`select * from agent_actions ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc limit 100 offset ${(page - 1) * 100}`, vals)).rows);
  res.json(rows);
});

// One-click kill switch and per-agent settings (owner only)
r.patch('/:agent', requirePerm('agents.control'), async (req, res) => {
  const agent = req.params.agent;
  const schema = agent === 'natalie'
    ? z.object({ enabled: z.boolean().optional(), autoReplyMessages: z.boolean().optional(), answerCalls: z.boolean().optional(), outboundCalls: z.boolean().optional(), displayName: z.string().min(1).max(40).optional(), languages: z.array(z.enum(['en', 'hy', 'ru', 'es'])).optional() })
    : agent === 'arev' ? z.object({ enabled: z.boolean().optional(), displayName: z.string().min(1).max(40).optional(), dataScopes: z.array(z.enum(['industry', 'product_type', 'decoration', 'quantity', 'source', 'status', 'created_at', 'company'])).optional() })
    : null;
  if (!schema) return res.status(404).json({ error: 'Unknown agent' });
  const b = parse(schema, req.body);
  if (b.languages && !b.languages.includes('en')) b.languages.unshift('en');
  const out = await withBiz(req.ctx.businessId, async c => {
    const before = (await getSettings(c, req.ctx.businessId)).agents[agent];
    const s = await patchSettings(c, req.ctx.businessId, { agents: { [agent]: b } });
    if (b.enabled === false) {
      // stop pending automatic work immediately
      await c.query(`update jobs set status = 'canceled', last_error = 'Agent turned off by owner' where status = 'pending' and kind like $1`, [agent === 'natalie' ? 'natalie.%' : 'arev.%']);
      if (agent === 'natalie') {
        await c.query(`update jobs set status = 'canceled', last_error = 'Natalie turned off' where status = 'pending' and kind = 'call.outbound_ai'`);
        await c.query(`update campaigns set status = 'paused', result = result || '{"pausedReason":"Natalie turned off"}' where kind = 'call_campaign' and status in ('running','scheduled')`);
      }
    }
    await audit(c, req.ctx, `agent.${agent}.update`, 'agent', agent, before, b);
    return s.agents[agent];
  });
  res.json(out);
});

// Transparency: show the owner Natalie's actual rules
r.get('/natalie/prompt', requirePerm('agents.read'), async (req, res) => {
  const text = await withBiz(req.ctx.businessId, async c => buildSystemPrompt({ settings: await getSettings(c, req.ctx.businessId), contact: { name: '(customer name)', phone_e164: '+1…' }, mode: 'messaging' }));
  res.json({ text });
});

export default r;
