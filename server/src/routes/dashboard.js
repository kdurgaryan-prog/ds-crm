import { Router } from 'express';
import { withBiz } from '../db.js';
import { requirePerm } from './auth.js';

export const dashboard = Router();
export const reports = Router();

const LA_DAY_END = `((date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day') at time zone 'America/Los_Angeles')`;

// Today's priorities. Every number links to the matching list in the UI.
dashboard.get('/', requirePerm('contacts.read'), async (req, res) => {
  const out = await withBiz(req.ctx.businessId, async c => {
    const one = async sql => (await c.query(sql)).rows[0];
    const counts = await one(`select
      (select count(*) from conversations where needs_reply and status <> 'done')::int unanswered,
      (select count(*) from calls where direction = 'inbound' and status in ('missed','no-answer','busy') and created_at > now() - interval '7 days')::int missed_calls,
      (select count(*) from tasks where done_at is null and kind = 'callback' and (due_at is null or due_at < ${LA_DAY_END}))::int callbacks,
      (select count(*) from tasks where done_at is null and due_at < now())::int overdue_tasks,
      (select count(*) from quotes where status in ('draft','pending_approval'))::int quotes_pending,
      (select count(*) from quotes where status = 'sent')::int quotes_waiting_customer,
      (select count(*) from orders where status not in ('Delivered','Canceled') and deadline <= current_date + 7)::int orders_due_soon,
      (select count(*) from contacts where status = 'New' and deleted_at is null and merged_into is null)::int new_leads,
      (select count(*) from campaigns where status = 'pending_approval')::int approvals,
      (select count(*) from jobs where status = 'dead' and updated_at > now() - interval '14 days')::int failed_actions,
      (select count(*) from duplicate_candidates where status = 'pending')::int duplicates,
      (select count(*) from messages where status in ('failed','unknown') and created_at > now() - interval '7 days')::int failed_messages`);
    const lists = {
      unanswered: (await c.query(`select cv.id, cv.channel, cv.last_message_at, c.name, c.company, c.lead_no from conversations cv join contacts c on c.id = cv.contact_id where cv.needs_reply and cv.status <> 'done' order by cv.last_message_at limit 6`)).rows,
      tasks: (await c.query(`select t.id, t.title, t.kind, t.due_at, t.contact_id, c.name, c.lead_no from tasks t left join contacts c on c.id = t.contact_id where t.done_at is null and (t.due_at is null or t.due_at < ${LA_DAY_END}) order by t.due_at nulls last limit 8`)).rows,
      orders: (await c.query(`select o.id, o.order_no, o.status, o.deadline, c.name, c.company from orders o join contacts c on c.id = o.contact_id where o.status not in ('Delivered','Canceled') and o.deadline <= current_date + 7 order by o.deadline limit 6`)).rows,
    };
    const channels = (await c.query(`select channel, status, last_error from channel_accounts`)).rows;
    return { counts, lists, channels };
  });
  res.json(out);
});

reports.get('/', requirePerm('reports.read'), async (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days || 30)));
  const out = await withBiz(req.ctx.businessId, async c => {
    const q = (sql, v = [days]) => c.query(sql, v).then(r => r.rows);
    const since = `now() - make_interval(days => $1)`;
    return {
      days,
      leadsBySource: await q(`select coalesce(source,'unknown') k, count(*)::int leads, count(*) filter (where status = 'Won')::int won from contacts where created_at > ${since} and deleted_at is null and merged_into is null group by 1 order by leads desc`),
      pipeline: await q(`select status k, count(*)::int n from contacts where deleted_at is null and merged_into is null group by 1`, []),
      leadsByDay: await q(`select to_char(date_trunc('day', created_at at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') d, count(*)::int n from contacts where created_at > ${since} and merged_into is null group by 1 order by 1`),
      byIndustry: await q(`select coalesce(industry,'unknown') k, count(*)::int n, count(*) filter (where status='Won')::int won from contacts where created_at > ${since} and merged_into is null group by 1 order by n desc limit 10`),
      byProduct: await q(`select coalesce(product_type,'unknown') k, count(*)::int n, coalesce(sum(quantity),0)::int qty from contacts where created_at > ${since} and merged_into is null group by 1 order by n desc limit 10`),
      quotes: (await q(`select count(*)::int created, count(*) filter (where status in ('sent','accepted'))::int sent, count(*) filter (where status='accepted')::int accepted, coalesce(sum(total) filter (where status='accepted'),0) accepted_value from quotes where created_at > ${since}`))[0],
      orders: await q(`select status k, count(*)::int n, coalesce(sum(total),0) value from orders where created_at > ${since} group by 1`),
      responseTime: (await q(`select percentile_cont(0.5) within group (order by extract(epoch from (o.created_at - i.created_at))/60) median_min
          from messages i join lateral (select created_at from messages o where o.conversation_id = i.conversation_id and o.direction = 'out' and o.created_at > i.created_at order by created_at limit 1) o on true
         where i.direction = 'in' and i.created_at > ${since}`))[0],
      calls: (await q(`select count(*)::int total, count(*) filter (where handled_by='ai')::int ai, count(*) filter (where status in ('missed','no-answer'))::int missed,
          coalesce(avg(duration_sec) filter (where duration_sec > 0),0)::int avg_sec from calls where created_at > ${since}`))[0],
      campaigns: await q(`select cp.id, cp.title, cp.kind, cp.status, cp.created_by_agent,
          (select count(*) from campaign_recipients r where r.campaign_id = cp.id and r.status in ('sent','queued','called'))::int reached,
          (select count(*) from campaign_recipients r where r.campaign_id = cp.id and r.status = 'skipped')::int skipped,
          (select count(distinct m.contact_id) from messages m join campaign_recipients r on r.contact_id = m.contact_id and r.campaign_id = cp.id
            where m.direction = 'in' and m.created_at > cp.updated_at)::int replies
        from campaigns cp where cp.created_at > ${since} order by cp.created_at desc limit 20`),
      agents: await q(`select agent, action, result, count(*)::int n from agent_actions where created_at > ${since} group by 1,2,3 order by n desc limit 30`),
    };
  });
  res.json(out);
});
