// Create the DS Systems business and its owner account (run once per environment).
// Usage: node server/scripts/bootstrap.js --email owner@example.com --name "Owner Name" [--password "..."]
import bcrypt from 'bcryptjs';
import { withSystem, pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { randomToken } from '../src/lib/crypto.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
if (!args.email || !args.name) { console.error('Usage: --email you@company.com --name "Your Name" [--password ...] [--business-slug ds-systems] [--business-name "DS Systems LLC"]'); process.exit(1); }

await migrate({ log: () => {} });
const password = args.password || randomToken(12);
const slug = args['business-slug'] || 'ds-systems';
const name = args['business-name'] || 'DS Systems LLC';
await withSystem(async c => {
  let biz = (await c.query('select * from businesses where slug = $1', [slug])).rows[0];
  if (!biz) biz = (await c.query('insert into businesses (slug, name, settings) values ($1,$2,$3) returning *', [slug, name, DEFAULT_SETTINGS])).rows[0];
  let u = (await c.query('select * from users where lower(email) = lower($1)', [args.email])).rows[0];
  if (!u) u = (await c.query('insert into users (email, name, password_hash) values ($1,$2,$3) returning *', [args.email.toLowerCase(), args.name, await bcrypt.hash(password, 11)])).rows[0];
  else if (args.password) await c.query('update users set password_hash = $2 where id = $1', [u.id, await bcrypt.hash(password, 11)]);
  await c.query(`insert into memberships (business_id, user_id, role) values ($1,$2,'owner') on conflict (business_id, user_id) do update set role = 'owner'`, [biz.id, u.id]);
  for (const ch of ['webchat', 'website_forms']) await c.query(`insert into channel_accounts (business_id, channel, status) values ($1,$2,'needs_setup') on conflict do nothing`, [biz.id, ch]);
  await c.query(`insert into channel_routes (provider, address, business_id) values ('public_key', $1, $2) on conflict do nothing`, [biz.public_key, biz.id]);
  console.log(`Business: ${biz.name} (${biz.slug})\nWebsite key: ${biz.public_key}\nOwner: ${args.email}${args.password ? '' : `\nTemporary password: ${password}`}`);
});
await pool.end();
