// Test harness: separate database, fake providers, scripted AI. Never touches real services.
import crypto from 'node:crypto';
process.env.APP_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://dscrm:dscrm@localhost/dscrm_test?host=/tmp';
process.env.APP_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.PUBLIC_URL = 'http://crm.test';
process.env.UPLOADS_DIR = '/tmp/dscrm-test-uploads';
process.env.SITE_ORIGINS = 'https://dssunifoems.com';
process.env.ANTHROPIC_API_KEY = '';

const { pool, withSystem, withBiz } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { DEFAULT_SETTINGS } = await import('../src/services/settings.js');
const { setTransport } = await import('../src/integrations/send.js');
const { setLLM } = await import('../src/agents/llm.js');
const { runDueJobs } = await import('../src/jobs/queue.js');
const { encryptJson } = await import('../src/lib/crypto.js');
const bcrypt = (await import('bcryptjs')).default;
const http = await import('node:http');

export { pool, withSystem, withBiz, runDueJobs, setLLM, setTransport };

export async function resetDb() {
  await pool.query('drop schema if exists public cascade; create schema public;');
  await pool.query('create extension if not exists pgcrypto; create extension if not exists pg_trgm;').catch(() => {});
  await migrate({ log: () => {} });
}

export const PASSWORD = 'test-password-123';
export async function makeBusiness(slug = 'ds-systems', name = 'DS Systems LLC') {
  return withSystem(async c => {
    const b = (await c.query('insert into businesses (slug, name, settings) values ($1,$2,$3) returning *', [slug, name, DEFAULT_SETTINGS])).rows[0];
    const users = {};
    for (const role of ['owner', 'admin', 'sales', 'marketing', 'viewer']) {
      const u = (await c.query('insert into users (email, name, password_hash) values ($1,$2,$3) returning *', [`${role}@${slug}.test`, `${role} ${slug}`, await bcrypt.hash(PASSWORD, 4)])).rows[0];
      await c.query('insert into memberships (business_id, user_id, role) values ($1,$2,$3)', [b.id, u.id, role]);
      users[role] = u;
    }
    return { ...b, users };
  });
}

/** Mark a channel connected with fake credentials + routing (skips the real provider check). */
export async function connectChannel(biz, channel, cfg, secrets) {
  await withBiz(biz.id, c => c.query(`insert into channel_accounts (business_id, channel, status, config, secrets_enc, last_checked_at) values ($1,$2,'connected',$3,$4, now())
    on conflict (business_id, channel) do update set status = 'connected', config = excluded.config, secrets_enc = excluded.secrets_enc`, [biz.id, channel, cfg, encryptJson(secrets)]));
  const routes = { sms: ['twilio_number', cfg.phoneNumber], voice: ['twilio_number', cfg.phoneNumber], whatsapp: ['whatsapp_number', cfg.whatsappNumber], messenger: ['fb_page', cfg.pageId], instagram: ['ig_account', cfg.igAccountId] }[channel];
  if (routes?.[1]) await withSystem(c => c.query('insert into channel_routes (provider, address, business_id) values ($1,$2,$3) on conflict do nothing', [...routes, biz.id]));
}

let server; let base;
export async function startServer() {
  server = http.createServer(createApp());
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
export async function stopServer() { await new Promise(r => server.close(r)); await pool.end(); }

/** Cookie-carrying API client for one user. */
export async function login(email) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'dscrm' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(`${base}/api${path}`, { method, headers: { cookie, 'x-requested-with': 'dscrm', ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...headers }, body: isForm ? body : body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { get: p => call('GET', p), post: (p, b, h) => call('POST', p, b, h), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: p => call('DELETE', p), raw: call };
}

/** POST a Twilio-signed form webhook. */
export async function twilioPost(path, params, authToken) {
  const twilio = (await import('twilio')).default;
  const url = `http://crm.test${path}`;
  const sig = twilio.getExpectedTwilioSignature(authToken, url, params);
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params) });
}

export function publicFetch(path, init = {}) { return fetch(`${base}${path}`, init); }

/** Run all due jobs, including ones scheduled slightly in the future (debounce). */
export async function drainJobs(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await withSystem(c => c.query(`update jobs set run_at = now() where status = 'pending' and run_at < now() + interval '1 minute'`));
    const n = await runDueJobs({ limit: 50 });
    if (!n) break;
  }
}

/** Fake provider: records every delivery. */
export function fakeTransport({ fail = 0, retryable = true } = {}) {
  const sent = [];
  let failures = fail;
  setTransport(async m => {
    if (failures > 0) { failures--; const e = new Error('provider down'); e.retryable = retryable; throw e; }
    sent.push(m); return { status: 'sent', providerId: `SM${sent.length}${crypto.randomBytes(3).toString('hex')}` };
  });
  return sent;
}

/** Scripted model: a function receiving the request and returning Anthropic-shaped content. */
export function fakeLLM(script) {
  const calls = [];
  setLLM(async req => { calls.push(req); const out = await script(req, calls.length); if (req.onText) for (const b of out.content || []) if (b.type === 'text') req.onText(b.text); return { stop_reason: (out.content || []).some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', ...out }; });
  return calls;
}
export const text = t => ({ content: [{ type: 'text', text: t }] });
export const tool = (name, input, t = '') => ({ content: [...(t ? [{ type: 'text', text: t }] : []), { type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name, input }] });
