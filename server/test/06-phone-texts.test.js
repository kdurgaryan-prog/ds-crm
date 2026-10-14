import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeBusiness, startServer, stopServer, login, fakeTransport, withBiz } from './helpers.js';

let biz, owner, sales, viewer, sent;
const mk = async (name, phone, extra = {}) => (await owner.post('/contacts', { name, company: `${name} Builders`, phone, source: 'license list', ...extra })).body.contact;

before(async () => {
  await resetDb();
  biz = await makeBusiness();
  await startServer();
  owner = await login('owner@ds-systems.test'); sales = await login('sales@ds-systems.test'); viewer = await login('viewer@ds-systems.test');
  sent = fakeTransport();
  // Tests run at any hour: open the sending window fully.
  await withBiz(biz.id, c => c.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"00:00","end":"23:59","timezone":"America/Los_Angeles","days":[1,2,3,4,5,6,7]}') where id = $1`, [biz.id]));
});
after(stopServer);

test('a phone list leaves out opted-out, Do Not Call and phone-less customers, and sends nothing itself', async () => {
  const a = await mk('Aram Petrosyan', '+13235550201');
  const b = await mk('Bella Ruiz', '+13235550202');
  const c = await mk('Carl Opted', '+13235550203');
  await owner.patch(`/contacts/${c.id}`, { sms_marketing: 'opted_out' });
  const d = await mk('Dana Dnc', '+13235550204', { dnc: true });
  const e = await mk('Eve Nophone', null);
  const r = await sales.post('/phone-texts/batches', { name: 'Contractors', ids: [a.id, b.id, c.id, d.id, e.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.added, 2);
  assert.deepEqual(r.body.excluded, { 'Asked not to be texted': 1, 'On Do Not Call list': 1, 'No phone number': 1 });
  assert.equal(sent.length, 0, 'the CRM never sends phone-list texts');
  // nobody can be in two open lists at once
  const again = await sales.post('/phone-texts/batches', { ids: [a.id] });
  assert.equal(again.body.added, 0);
  assert.equal(again.body.excluded['Already in another open list'], 1);
  // viewers cannot use it
  assert.equal((await viewer.post('/phone-texts/batches', { ids: [a.id] })).status, 403);
});

test('working the list: filled-in text, sent once, timeline and status updated', async () => {
  const list = (await sales.get('/phone-texts/batches')).body.find(x => x.name === 'Contractors');
  const n1 = (await sales.get(`/phone-texts/batches/${list.id}/next`)).body;
  const first = n1.item.contact.name.split(' ')[0];
  assert.match(n1.item.body, new RegExp(`^Hi ${first}, this is DS Systems`));
  assert.ok(n1.item.body.includes(`${n1.item.contact.name} Builders`));
  assert.match(n1.item.body, /STOP/);
  // a teammate opening the list gets a different person
  const o1 = (await owner.get(`/phone-texts/batches/${list.id}/next`)).body;
  assert.notEqual(o1.item.contact.id, n1.item.contact.id);
  assert.equal((await owner.post(`/phone-texts/items/${n1.item.id}/sent`)).status, 400, 'cannot mark a teammate\'s person');
  assert.equal((await sales.post(`/phone-texts/items/${n1.item.id}/sent`)).status, 200);
  const twice = await sales.post(`/phone-texts/items/${n1.item.id}/sent`);
  assert.equal(twice.body.already, true);
  const card = (await sales.get(`/contacts/${n1.item.contact.id}`)).body;
  assert.equal(card.contact.status, 'Contacted');
  assert.equal(card.timeline.filter(t => /^Texted from .*phone/.test(t.summary)).length, 1);
  await owner.post(`/phone-texts/items/${o1.item.id}/skip`, { reason: 'Not a mobile number' });
  const done = (await sales.get(`/phone-texts/batches/${list.id}/next`)).body;
  assert.equal(done.done, true);
  assert.deepEqual({ sent: done.counts.sent, skipped: done.counts.skipped }, { sent: 1, skipped: 1 });
});

test('someone who opts out after the list was made is skipped at send time; no repeat within 30 days', async () => {
  const f = await mk('Frank Later', '+13235550206');
  const g = await mk('Gina Ok', '+13235550207');
  const aram = (await sales.get('/contacts?q=Aram')).body.rows[0].status === 'Contacted' ? (await sales.get('/contacts?q=Aram')).body.rows[0] : (await sales.get('/contacts?q=Bella')).body.rows[0];
  const r = await sales.post('/phone-texts/batches', { ids: [f.id, g.id, aram.id] });
  assert.equal(r.body.added, 2);
  assert.equal(r.body.excluded['Already texted in the last 30 days'], 1);
  await sales.post(`/contacts/${f.id}/phone-reply`, { text: 'Stop texting me' });     // e.g. replied to another staff phone
  const n = (await sales.get(`/phone-texts/batches/${r.body.batch.id}/next`)).body;
  assert.equal(n.item.contact.name, 'Gina Ok');
  const fc = (await sales.get(`/contacts/${f.id}`)).body.contact;
  assert.equal(fc.sms_marketing, 'opted_out'); assert.ok(fc.opted_out_at);
});

test('a normal reply is logged on the card; the daily limit and sending hours pause the list', async () => {
  const g = (await sales.get('/contacts?q=Gina')).body.rows[0];
  const rep = await sales.post(`/contacts/${g.id}/phone-reply`, { text: 'Yes, send me info on polos' });
  assert.equal(rep.body.optedOut, false);
  assert.ok((await sales.get(`/contacts/${g.id}`)).body.timeline.some(t => /Replied to .*polos/.test(t.summary)));

  const h = await mk('Hank Limit', '+13235550208');
  const batch = (await sales.post('/phone-texts/batches', { ids: [h.id] })).body.batch;
  await owner.patch('/settings', { phoneText: { dailyLimit: 1 } });
  const p = (await sales.get(`/phone-texts/batches/${batch.id}/next`)).body;
  assert.match(p.paused, /limit of 1/);
  await owner.patch('/settings', { phoneText: { dailyLimit: 200 } });
  await withBiz(biz.id, c => c.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"00:00","end":"00:01","timezone":"America/Los_Angeles","days":[1,2,3,4,5,6,7]}') where id = $1`, [biz.id]));
  const q = (await sales.get(`/phone-texts/batches/${batch.id}/next`)).body;
  assert.match(q.paused, /Outside sending hours/);
  await withBiz(biz.id, c => c.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"00:00","end":"23:59","timezone":"America/Los_Angeles","days":[1,2,3,4,5,6,7]}') where id = $1`, [biz.id]));
});

test('phone-list template must keep the opt-out line; businesses never see each other\'s lists', async () => {
  const bad = await owner.patch('/settings', { phoneText: { template: 'Hi {first_name}, uniforms for {company}?' } });
  assert.equal(bad.status, 400);
  const other = await makeBusiness('other-shop', 'Other Shop');
  const o = await login('owner@other-shop.test');
  assert.equal((await o.get('/phone-texts/batches')).body.length, 0);
  const mine = (await sales.get('/phone-texts/batches')).body[0];
  assert.equal((await o.get(`/phone-texts/batches/${mine.id}/next`)).status, 404);
  const rows = await withBiz(other.id, c => c.query('select count(*)::int n from phone_text_items'));
  assert.equal(rows.rows[0].n, 0);
});

test('quiet hours: sending window must stay within 08:00-21:00; area codes give the customer\'s time zone', async () => {
  assert.equal((await owner.patch('/settings', { campaignHours: { start: '09:00', end: '21:30' } })).status, 400);
  assert.equal((await owner.patch('/settings', { campaignHours: { start: '07:30', end: '17:00' } })).status, 400);
  assert.equal((await owner.patch('/settings', { campaignHours: { start: '09:00', end: '21:00' } })).status, 200);
  const { timezoneFor, withinCampaignHours } = await import('../src/services/compliance.js');
  assert.equal(timezoneFor({ phone_e164: '+17475550100' }), 'America/Los_Angeles');
  assert.equal(timezoneFor({ phone_e164: '+16025550100' }), 'America/Phoenix');
  assert.equal(timezoneFor({ phone_e164: '+12125550100' }), null);                 // New York: not guessed
  assert.equal(timezoneFor({ phone_e164: '+12125550100', timezone: 'America/New_York' }), 'America/New_York');
  const H = { start: '09:00', end: '21:00', timezone: 'America/Los_Angeles', days: [1, 2, 3, 4, 5] };
  const tue1946 = new Date('2026-10-14T02:46:00Z');                                 // Tue 19:46 in Los Angeles
  assert.equal(withinCampaignHours(H, timezoneFor({ phone_e164: '+17475550100' }), tue1946).ok, true);
  assert.equal(withinCampaignHours(H, timezoneFor({ phone_e164: '+12125550100' }), tue1946).ok, false); // 22:46 in New York
});
