// Separate TEST data for development/staging. Refuses to run in production.
// All test customers use 555-01xx numbers (reserved for fiction) and "TEST" company names.
import bcrypt from 'bcryptjs';
import { withSystem, withBiz, pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { config } from '../src/config.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';
import { createContact } from '../src/services/contacts.js';
import { handleInbound, queueOutbound } from '../src/services/messaging.js';
import { createQuote, transitionQuote, orderFromQuote } from '../src/services/sales.js';

if (config.appEnv === 'production') { console.error('Refusing to seed test data in production.'); process.exit(1); }
await migrate({ log: () => {} });

const PASS = process.env.SEED_PASSWORD || 'test-password-123';
const biz = await withSystem(async c => {
  let b = (await c.query(`select * from businesses where slug = 'ds-systems'`)).rows[0];
  if (!b) b = (await c.query(`insert into businesses (slug, name, settings) values ('ds-systems','DS Systems LLC',$1) returning *`, [DEFAULT_SETTINGS])).rows[0];
  const users = [['owner@test.dssystems.local', 'Test Owner', 'owner'], ['sales@test.dssystems.local', 'Sam Sales', 'sales'], ['marketing@test.dssystems.local', 'Mia Marketing', 'marketing'], ['viewer@test.dssystems.local', 'Vic Viewer', 'viewer'], ['admin@test.dssystems.local', 'Ada Admin', 'admin']];
  for (const [email, name, role] of users) {
    const u = (await c.query(`insert into users (email, name, password_hash) values ($1,$2,$3) on conflict (email) do update set name = excluded.name returning id`, [email, name, await bcrypt.hash(PASS, 8)])).rows[0];
    await c.query(`insert into memberships (business_id, user_id, role) values ($1,$2,$3) on conflict (business_id, user_id) do update set role = excluded.role`, [b.id, u.id, role]);
  }
  await c.query(`insert into channel_routes (provider, address, business_id) values ('public_key', $1, $2) on conflict do nothing`, [b.public_key, b.id]);
  return b;
});

await withBiz(biz.id, async c => {
  const owner = (await c.query(`select u.id from users u where email = 'owner@test.dssystems.local'`)).rows[0].id;
  const sales = (await c.query(`select u.id from users u where email = 'sales@test.dssystems.local'`)).rows[0].id;
  const ctx = { businessId: biz.id, userId: owner };
  if ((await c.query('select count(*)::int n from contacts')).rows[0].n > 0) { console.log('Test data already present.'); return; }

  const price = [
    ['TEE-DTF', 'Cotton tee with DTF print', 'T-shirts', 'DTF printing', 20, 11.5], ['TEE-DTF', 'Cotton tee with DTF print', 'T-shirts', 'DTF printing', 50, 9.75], ['TEE-DTF', 'Cotton tee with DTF print', 'T-shirts', 'DTF printing', 100, 8.25],
    ['TEE-SCR', 'Cotton tee, 1-color screen print', 'T-shirts', 'Screen printing', 50, 7.5], ['POLO-EMB', 'Performance polo, left-chest embroidery', 'Polos', 'Embroidery', 20, 22], ['POLO-EMB', 'Performance polo, left-chest embroidery', 'Polos', 'Embroidery', 50, 19.5],
    ['HOOD-EMB', 'Pullover hoodie, embroidery', 'Hoodies', 'Embroidery', 20, 34], ['HAT-EMB', 'Structured cap, front embroidery', 'Hats', 'Embroidery', 20, 16], ['VEST-DTF', 'Hi-vis safety vest, DTF logo', 'Safety vests', 'DTF printing', 20, 14],
  ];
  for (const [sku, name, pt, dec, mq, up] of price) await c.query(`insert into price_list (business_id, sku, name, product_type, decoration, min_qty, unit_price, approved_by, approved_at) values ($1,$2,$3,$4,$5,$6,$7,$8, now()) on conflict do nothing`, [biz.id, sku, name, pt, dec, mq, up, owner]);

  const people = [
    ['Maria Lopez', 'TEST Lopez Construction', '(213) 555-0101', 'construction', 'Safety vests', 60, 'DTF printing', 'call', 'Qualified'],
    ['Daniel Kim', 'TEST Seoul Kitchen', '(213) 555-0102', 'restaurant', 'Polos', 25, 'Embroidery', 'instagram', 'Quote Sent'],
    ['Ani Petrosyan', 'TEST Little Stars Daycare', '(818) 555-0103', 'daycare', 'T-shirts', 40, 'DTF printing', 'website_quote', 'New'],
    ['James Carter', 'TEST Fade Masters Barbershop', '(323) 555-0104', 'barbershop', 'Hoodies', 12, 'Embroidery', 'sms', 'Contacted'],
    ['Sofia Ramirez', 'TEST Glow Salon', '(310) 555-0105', 'salon', 'T-shirts', 30, 'Screen printing', 'messenger', 'Waiting'],
    ['Robert Chen', 'TEST FastLane Logistics', '(562) 555-0106', 'logistics', 'Hats', 100, 'Embroidery', 'call', 'Won'],
    ['Karen White', 'TEST Sunrise Cafe', '(213) 555-0107', 'restaurant', 'T-shirts', 20, 'DTF printing', 'whatsapp', 'Lost'],
  ];
  const made = [];
  for (const [name, company, phone, industry, product_type, quantity, decoration, source, status] of people) {
    const deadline = new Date(Date.now() + (7 + made.length * 5) * 86400_000).toISOString().slice(0, 10);
    const { contact } = await createContact(c, ctx, { name, company, phone_raw: phone, industry, product_type, quantity, decoration, source, status, deadline, owner_user_id: made.length % 2 ? sales : owner, sms_marketing: made.length % 3 === 0 ? 'opted_in' : 'unknown' });
    made.push(contact);
  }
  // a possible duplicate (same name, different phone) → goes to review, not merged
  await createContact(c, ctx, { name: 'Maria Lopez', company: 'TEST Lopez Construction', phone_raw: '(213) 555-0199', source: 'webchat' });
  // conversations (inbound recorded; replies are sandbox-only)
  await c.query(`update businesses set settings = jsonb_set(settings, '{agents,natalie,autoReplyMessages}', 'false') where id = $1`, [biz.id]);
  const r1 = await handleInbound(c, ctx, { channel: 'sms', thread: made[3].phone_e164, phone: made[3].phone_e164, body: 'Hi, do you do embroidered hoodies? Need about 12 for my shop.', providerId: 'TEST-SM1' });
  await handleInbound(c, ctx, { channel: 'instagram', thread: 'ig_test_1001', name: 'Daniel Kim', body: 'Got the quote, can we add 5 aprons?', providerId: 'TEST-IG1' });
  await handleInbound(c, ctx, { channel: 'webchat', thread: 'v_testvisitor01', body: 'Do you print on safety vests?', providerId: 'TEST-WC1' });
  await queueOutbound(c, { ...ctx, userId: sales }, { conversation: r1.conversation, body: 'Yes we do! Our minimum is 20 of the same item and color — want me to have the team review 12?', authorType: 'user', key: 'seed-1' });
  await c.query(`update businesses set settings = jsonb_set(settings, '{agents,natalie,autoReplyMessages}', 'true') where id = $1`, [biz.id]);
  // tasks, quote → order
  await c.query(`insert into tasks (business_id, contact_id, title, kind, due_at, assignee_user_id) values ($1,$2,'Call back about vest colors','callback', now() - interval '2 hours',$3), ($1,$4,'Send embroidery mockup','task', now() + interval '1 day',$5)`, [biz.id, made[0].id, owner, made[1].id, sales]);
  const q = await createQuote(c, ctx, { contactId: made[5].id, items: [{ sku: 'HAT-EMB', qty: 100, description: 'Structured cap, front embroidery' }], production_days: 10 });
  await transitionQuote(c, { ...ctx, role: 'owner' }, q.id, 'approve');
  await orderFromQuote(c, ctx, q.id);
  const q2 = await createQuote(c, ctx, { contactId: made[1].id, items: [{ sku: 'POLO-EMB', qty: 25, description: 'Performance polo, left-chest embroidery' }] });
  await transitionQuote(c, { ...ctx, role: 'owner' }, q2.id, 'submit');
  await c.query(`insert into calls (business_id, contact_id, direction, from_number, to_number, status, handled_by, duration_sec, summary, outcome, next_action, created_at)
    values ($1,$2,'inbound',$3,'+12135550100','completed','ai',184,'Caller needs 60 hi-vis vests with logo for a new crew. Wants delivery in 2 weeks.','Qualified','Prepare quote', now() - interval '1 day'),
           ($1,$4,'inbound',$5,'+12135550100','missed','user',0,null,null,null, now() - interval '3 hours')`, [biz.id, made[0].id, made[0].phone_e164, made[4].id, made[4].phone_e164]);
  await c.query(`insert into canned_replies (business_id, title, body) values ($1,'Quote link','You can request a written quote here: https://dssunifoems.com/pages/contact — we usually reply within one business day.'), ($1,'Minimum order','Our minimum is 20 pieces of the same item and color. Happy to help you plan an order that fits!')`, [biz.id]);
  console.log(`Seeded test data. Logins (password "${PASS}"): owner@ / admin@ / sales@ / marketing@ / viewer@test.dssystems.local`);
});
console.log(`Website key: ${biz.public_key}`);
await pool.end();
