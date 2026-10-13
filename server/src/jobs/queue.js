import { withSystem, withBiz } from '../db.js';

export class RetryableError extends Error { constructor(m) { super(m); this.retryable = true; } }
export class PermanentError extends Error { constructor(m) { super(m); this.retryable = false; } }

/** Enqueue a job inside the caller's transaction. Same idempotency key → no second job. */
export async function enqueue(c, businessId, kind, payload = {}, { key = null, runAt = null, maxAttempts = 5 } = {}) {
  const { rows } = await c.query(
    `insert into jobs (business_id, kind, payload, idempotency_key, run_at, max_attempts)
     values ($1,$2,$3,$4, coalesce($5, now()), $6)
     on conflict (business_id, idempotency_key) do nothing returning id`,
    [businessId, kind, payload, key, runAt, maxAttempts]);
  return rows[0]?.id || null;
}

const handlers = new Map();
export function registerHandler(kind, fn) { handlers.set(kind, fn); }

const backoff = attempt => Math.min(60 * 60, 15 * 2 ** (attempt - 1)); // 15s, 30s, 60s … max 1h

/** Claim and run due jobs. Returns number processed. */
export async function runDueJobs({ limit = 10 } = {}) {
  // Jobs stuck in "running" (worker crash). Delivery jobs are NOT re-run blindly: the provider may already have sent.
  await withSystem(async c => {
    const stuck = (await c.query(`select * from jobs where status = 'running' and locked_at < now() - interval '10 minutes'`)).rows;
    for (const j of stuck) {
      if (['message.send', 'call.post_sms', 'campaign.publish', 'call.outbound_ai'].includes(j.kind)) {
        const what = { 'campaign.publish': 'publishing', 'call.outbound_ai': 'placing a call' }[j.kind] || 'sending';
        await c.query(`update jobs set status = 'dead', last_error = $2, updated_at = now() where id = $1`, [j.id, `The server stopped while ${what}. It may already have happened — check before retrying.`]);
        if (j.payload.messageId) await c.query(`update messages set status = 'unknown', status_detail = 'Delivery status unknown after a server interruption. Check before resending.' where id = $1 and status = 'sending'`, [j.payload.messageId]);
      } else {
        await c.query(`update jobs set status = 'pending', locked_at = null, updated_at = now() where id = $1`, [j.id]);
      }
    }
  });
  const jobs = await withSystem(async c => (await c.query(
    `update jobs set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
      where id in (select id from jobs where status = 'pending' and run_at <= now() order by run_at limit $1 for update skip locked)
      returning *`, [limit])).rows);
  for (const job of jobs) {
    const fn = handlers.get(job.kind);
    try {
      if (!fn) throw new PermanentError(`No handler for ${job.kind}`);
      const out = await fn(job);
      await withBiz(job.business_id, c => c.query(
        `update jobs set status = case when $2::jsonb ? 'reschedule' then 'pending' else 'done' end,
                run_at = case when $2::jsonb ? 'reschedule' then now() + make_interval(secs => ($2::jsonb->>'reschedule')::int) else run_at end,
                attempts = case when $2::jsonb ? 'reschedule' then 0 else attempts end,
                last_error = null, locked_at = null, updated_at = now() where id = $1`, [job.id, out && typeof out === 'object' ? out : {}]));
    } catch (e) {
      const retry = e.retryable !== false && job.attempts < job.max_attempts;
      await withBiz(job.business_id, c => c.query(
        `update jobs set status = $2, last_error = $3, locked_at = null, run_at = now() + make_interval(secs => $4), updated_at = now() where id = $1`,
        [job.id, retry ? 'pending' : 'dead', String(e.message || e).slice(0, 2000), backoff(job.attempts)]));
      if (!retry && handlers.get(job.kind + ':dead')) {
        await handlers.get(job.kind + ':dead')(job, e).catch(err => console.error('[jobs] dead handler failed', err));
      }
    }
  }
  return jobs.length;
}

let timer = null;
export function startWorker({ intervalMs = 1500 } = {}) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { while (await runDueJobs() > 0); } catch (e) { console.error('[worker]', e.message); } finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
}
export function stopWorker() { clearInterval(timer); timer = null; }
