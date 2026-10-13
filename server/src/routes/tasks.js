import { Router } from 'express';
import { z } from 'zod';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';
import { parse, notFound } from '../lib/http.js';
import { activity, audit } from '../services/audit.js';

const r = Router();
const input = z.object({
  title: z.string().min(1, 'Add a title').max(300), contact_id: z.string().uuid().nullish(), order_id: z.string().uuid().nullish(),
  kind: z.enum(['task', 'callback', 'meeting', 'handoff', 'follow_up']).default('task'), due_at: z.string().datetime({ offset: true }).nullish(),
  assignee_user_id: z.string().uuid().nullish(),
});

r.get('/', requirePerm('contacts.read'), async (req, res) => {
  const { view = 'open', assignee, from, to } = req.query;
  const where = []; const vals = [];
  const p = v => { vals.push(v); return `$${vals.length}`; };
  if (view === 'open') where.push('t.done_at is null');
  if (view === 'overdue') where.push('t.done_at is null and t.due_at < now()');
  if (view === 'today') where.push(`t.done_at is null and t.due_at < (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day') at time zone 'America/Los_Angeles'`);
  if (view === 'callbacks') where.push(`t.done_at is null and t.kind = 'callback'`);
  if (view === 'done') where.push('t.done_at is not null');
  if (assignee === 'me') where.push(`t.assignee_user_id = ${p(req.ctx.userId)}`);
  if (from) where.push(`t.due_at >= ${p(from)}`);
  if (to) where.push(`t.due_at < ${p(to)}`);
  const rows = await withBiz(req.ctx.businessId, async c => (await c.query(
    `select t.*, c.name contact_name, c.company, c.lead_no, u.name assignee_name from tasks t left join contacts c on c.id = t.contact_id left join users u on u.id = t.assignee_user_id
      ${where.length ? 'where ' + where.join(' and ') : ''} order by t.due_at nulls last, t.created_at desc limit 500`, vals)).rows);
  res.json(rows);
});

// calendar: tasks + order deadlines + lead deadlines in a range
r.get('/calendar', requirePerm('contacts.read'), async (req, res) => {
  const from = req.query.from; const to = req.query.to;
  const out = await withBiz(req.ctx.businessId, async c => ({
    tasks: (await c.query(`select t.id, t.title, t.kind, t.due_at, t.done_at, t.contact_id, c.name contact_name from tasks t left join contacts c on c.id = t.contact_id where t.due_at >= $1 and t.due_at < $2`, [from, to])).rows,
    orders: (await c.query(`select o.id, o.order_no, o.status, o.deadline, c.name contact_name, c.company from orders o join contacts c on c.id = o.contact_id where o.deadline >= $1::date and o.deadline < $2::date and o.status not in ('Delivered','Canceled')`, [from, to])).rows,
  }));
  res.json(out);
});

r.post('/', requirePerm('tasks.write'), async (req, res) => {
  const b = parse(input, req.body);
  const t = await withBiz(req.ctx.businessId, async c => {
    const row = (await c.query(`insert into tasks (business_id, contact_id, order_id, title, kind, due_at, assignee_user_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [req.ctx.businessId, b.contact_id || null, b.order_id || null, b.title, b.kind, b.due_at || null, b.assignee_user_id || req.ctx.userId, req.ctx.userId])).rows[0];
    if (row.contact_id) await activity(c, req.ctx, row.contact_id, 'task', `Task added: ${row.title}`, { refId: row.id });
    return row;
  });
  res.status(201).json(t);
});

r.patch('/:id', requirePerm('tasks.write'), async (req, res) => {
  const b = parse(input.partial().extend({ done: z.boolean().optional() }), req.body);
  const t = await withBiz(req.ctx.businessId, async c => {
    const cur = (await c.query('select * from tasks where id = $1', [req.params.id])).rows[0];
    if (!cur) throw notFound('Task not found.');
    const row = (await c.query(`update tasks set title = coalesce($2, title), due_at = case when $3::boolean then $4::timestamptz else due_at end,
              assignee_user_id = coalesce($5, assignee_user_id), kind = coalesce($6, kind),
              done_at = case when $7::boolean is null then done_at when $7 then now() else null end where id = $1 returning *`,
      [cur.id, b.title ?? null, b.due_at !== undefined, b.due_at ?? null, b.assignee_user_id ?? null, b.kind ?? null, b.done ?? null])).rows[0];
    if (b.done && row.contact_id) await activity(c, req.ctx, row.contact_id, 'task', `Task done: ${row.title}`, { refId: row.id });
    await audit(c, req.ctx, 'task.update', 'task', row.id, null, b);
    return row;
  });
  res.json(t);
});

r.delete('/:id', requirePerm('tasks.write'), async (req, res) => {
  await withBiz(req.ctx.businessId, async c => { await c.query('delete from tasks where id = $1', [req.params.id]); await audit(c, req.ctx, 'task.delete', 'task', req.params.id); });
  res.json({ ok: true });
});

export default r;
