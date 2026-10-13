import pg from 'pg';
import { config } from './config.js';

// numeric → JS number (amounts are stored with 2 decimals; safe within business ranges)
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));
// date → keep as 'YYYY-MM-DD' string to avoid timezone shifts
pg.types.setTypeParser(1082, v => v);
pg.types.setTypeParser(20, v => (v === null ? null : Number(v))); // bigint counters

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL || 10) });

/** Run fn(client) in a transaction scoped to one business (RLS enforced). */
export async function withBiz(businessId, fn) {
  if (!businessId) throw new Error('withBiz requires a business id');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.business_id', $1, true), set_config('app.system', 'off', true)", [businessId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Internal cross-tenant context: webhook routing, job claiming, login. Never used with user input as scope. */
export async function withSystem(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.system', 'on', true)");
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function nextNumber(client, businessId, name) {
  const { rows } = await client.query(
    `insert into counters (business_id, name, value) values ($1, $2, 1)
     on conflict (business_id, name) do update set value = counters.value + 1
     returning value`, [businessId, name]);
  return Number(rows[0].value);
}
