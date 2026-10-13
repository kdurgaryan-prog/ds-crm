import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { withSystem, withBiz } from '../db.js';
import { config } from '../config.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { AppError, parse, forbidden } from '../lib/http.js';
import { can, permissionsFor } from '../lib/permissions.js';
import { getSettings } from '../services/settings.js';

export const COOKIE = 'dscrm_session';

/** Attaches req.ctx = { userId, businessId, role, ip } or 401. */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) throw new AppError(401, 'Please sign in.', { code: 'unauthenticated' });
    const row = await withSystem(async c => (await c.query(
      `select s.user_id, s.business_id, m.role, u.name, u.email, u.active
         from sessions s join memberships m on m.user_id = s.user_id and m.business_id = s.business_id
         join users u on u.id = s.user_id
        where s.id = $1 and s.expires_at > now() and m.active`, [sha256(token)])).rows[0]);
    if (!row || !row.active) throw new AppError(401, 'Your session has ended. Please sign in again.', { code: 'unauthenticated' });
    req.ctx = { userId: row.user_id, businessId: row.business_id, role: row.role, name: row.name, email: row.email, ip: req.ip };
    next();
  } catch (e) { next(e); }
}

export const requirePerm = perm => (req, _res, next) => (can(req.ctx?.role, perm) ? next() : next(forbidden()));

// CSRF protection: state-changing requests must come from our own origin with the JSON header our client sets.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'dscrm') return next(new AppError(403, 'Request blocked.', { code: 'csrf' }));
  next();
}

const router = Router();

async function rateLimit(key) {
  return withSystem(async c => {
    const { rows } = await c.query(
      `insert into login_attempts (key, count, window_start) values ($1, 1, now())
       on conflict (key) do update set
         count = case when login_attempts.window_start < now() - interval '15 minutes' then 1 else login_attempts.count + 1 end,
         window_start = case when login_attempts.window_start < now() - interval '15 minutes' then now() else login_attempts.window_start end
       returning count`, [key]);
    return rows[0].count;
  });
}

router.post('/login', async (req, res) => {
  const { email, password, business } = parse(z.object({ email: z.string().email(), password: z.string().min(1), business: z.string().optional() }), req.body);
  const attempts = await rateLimit(`login:${email.toLowerCase()}:${req.ip}`);
  if (attempts > 10) throw new AppError(429, 'Too many sign-in attempts.', { hint: 'Wait 15 minutes and try again.' });
  const found = await withSystem(async c => {
    const u = (await c.query('select * from users where lower(email) = lower($1) and active', [email])).rows[0];
    if (!u) return null;
    const ms = (await c.query(
      `select m.business_id, m.role, b.slug, b.name from memberships m join businesses b on b.id = m.business_id where m.user_id = $1 and m.active order by b.created_at`, [u.id])).rows;
    return { u, ms };
  });
  const ok = found && await bcrypt.compare(password, found.u.password_hash);
  if (!ok || !found.ms.length) throw new AppError(401, 'Email or password is incorrect.', { code: 'bad_credentials' });
  const m = found.ms.find(x => x.slug === business) || found.ms[0];
  const token = randomToken();
  await withSystem(c => c.query(
    `insert into sessions (id, user_id, business_id, expires_at, ip, user_agent) values ($1,$2,$3, now() + make_interval(days => $4), $5, $6)`,
    [sha256(token), found.u.id, m.business_id, config.sessionDays, req.ip, req.get('user-agent') || null]));
  await withBiz(m.business_id, c => c.query(
    `insert into audit_log (business_id, actor_user_id, action, entity, entity_id, ip) values ($1,$2::uuid,'login','user',$2::text,$3)`, [m.business_id, found.u.id, req.ip]));
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.appEnv === 'production' || config.appEnv === 'staging',
    maxAge: config.sessionDays * 86400_000, path: '/',
  });
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await withSystem(c => c.query('delete from sessions where id = $1', [sha256(token)]));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const { ctx } = req;
  const data = await withBiz(ctx.businessId, async c => {
    const biz = (await c.query('select id, slug, name, public_key from businesses where id = $1', [ctx.businessId])).rows[0];
    const prefs = (await c.query('select prefs from user_prefs where user_id = $1', [ctx.userId])).rows[0]?.prefs || {};
    const settings = await getSettings(c, ctx.businessId);
    return { biz, prefs, settings };
  });
  const businesses = await withSystem(async c => (await c.query(
    `select b.slug, b.name from memberships m join businesses b on b.id = m.business_id where m.user_id = $1 and m.active`, [ctx.userId])).rows);
  res.json({
    user: { id: ctx.userId, name: ctx.name, email: ctx.email, role: ctx.role },
    permissions: permissionsFor(ctx.role),
    business: { id: data.biz.id, slug: data.biz.slug, name: data.biz.name },
    businesses,
    prefs: data.prefs,
    agents: { natalie: data.settings.agents.natalie.displayName, arev: data.settings.agents.arev.displayName },
    appEnv: config.appEnv,
  });
});

router.post('/switch-business', requireAuth, csrfGuard, async (req, res) => {
  const { slug } = parse(z.object({ slug: z.string() }), req.body);
  const m = await withSystem(async c => (await c.query(
    `select m.business_id from memberships m join businesses b on b.id = m.business_id where m.user_id = $1 and b.slug = $2 and m.active`, [req.ctx.userId, slug])).rows[0]);
  if (!m) throw forbidden('You are not a member of that business.');
  await withSystem(c => c.query('update sessions set business_id = $2 where id = $1', [sha256(req.cookies[COOKIE]), m.business_id]));
  res.json({ ok: true });
});

router.post('/password', requireAuth, csrfGuard, async (req, res) => {
  const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters') }), req.body);
  await withSystem(async c => {
    const u = (await c.query('select password_hash from users where id = $1', [req.ctx.userId])).rows[0];
    if (!(await bcrypt.compare(current, u.password_hash))) throw new AppError(400, 'Current password is incorrect.');
    await c.query('update users set password_hash = $2 where id = $1', [req.ctx.userId, await bcrypt.hash(next, 11)]);
    await c.query('delete from sessions where user_id = $1 and id <> $2', [req.ctx.userId, sha256(req.cookies[COOKIE])]);
  });
  res.json({ ok: true });
});

export default router;
