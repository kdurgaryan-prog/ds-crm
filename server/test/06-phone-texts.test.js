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

test('import reads licensing-board columns: title, address, city, county, ZIP; lists filter by them', async () => {
  const csv = 'Business Name,Licensee Name,Title,Business Phone,Address,City,County,ZIP Code,Industry,Source\n'
    + 'Valley Roofing Inc,Mike Torres,RMO,(818) 555-0311,123 Main St,Van Nuys,Los Angeles,91401,Construction,CSLB\n'
    + 'Bay Plumbing,Lisa Wong,Owner,(415) 555-0312,9 Market St,San Francisco,San Francisco,94103-1234,Construction,CSLB\n';
  const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'cslb.csv');
  const r = await owner.post('/contacts/import?commit=1', fd);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 2);
  const la = (await owner.get('/contacts?county=Los%20Angeles&industry=Construction')).body;
  assert.equal(la.total, 1);
  assert.deepEqual([la.rows[0].company, la.rows[0].name, la.rows[0].title, la.rows[0].city, la.rows[0].zip], ['Valley Roofing Inc', 'Mike Torres', 'RMO', 'Van Nuys', '91401']);
  assert.equal((await owner.get('/contacts?zip=941')).body.rows[0].zip, '94103-1234');
  const facets = (await owner.get('/contacts/facets')).body;
  assert.ok(facets.cities.includes('Van Nuys') && facets.counties.includes('San Francisco') && facets.industries.includes('Construction'));
  // a phone list made from these filters
  const list = await sales.post('/phone-texts/batches', { name: 'LA roofers', filters: { county: 'Los Angeles', industry: 'Construction' } });
  assert.equal(list.body.added, 1);
  assert.equal((await owner.patch(`/contacts/${la.rows[0].id}`, { zip: 'abc' })).status, 400);
});

test('import the owner\'s Excel layout as is (N, License #, Business Name, Contact Name, … industry type)', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('CSLB');
  ws.addRow(['N', 'License #', 'Business Name', 'Contact Name', 'Title', 'Business Type', 'Address', 'City', 'Zip', 'County', 'Phone', 'Other Personnel', 'industry', 'industry type']);
  ws.addRow([1, 1012345, 'Sunset Electric Inc', 'Ara Hakobyan', 'RMO', 'Corporation', '55 Sunset Blvd', 'Glendale', 91203, 'Los Angeles', 8185550411, 'Nara Hakobyan (CEO)', 'Construction', 'C-10 Electrical']);
  ws.addRow([2, 1012346, 'Pacific Paint Co', 'Tom Reyes', 'Owner', 'Sole Owner', '7 Ocean Ave', 'Long Beach', 90802, 'Los Angeles', '(562) 555-0412', '', 'Construction', 'C-33 Painting']);
  ws.addRow([3, 1012347, 'No Phone LLC', 'Sam Lee', 'Owner', 'LLC', '', 'Pasadena', 91101, 'Los Angeles', 'n/a', '', 'Construction', 'C-33 Painting']);
  const buf = await wb.xlsx.writeBuffer();
  const file = () => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'CSLB LA.xlsx'); return fd; };
  const pre = await owner.post('/contacts/import?source=CSLB%20LA', file());
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.deepEqual(pre.body.columns.ignored, []);
  assert.ok(pre.body.columns.used.includes('license') && pre.body.columns.used.includes('industry_type'));
  assert.equal(pre.body.invalid.length, 1);                       // "n/a" is not a phone
  const r = await owner.post('/contacts/import?commit=1&source=CSLB%20LA', file());
  assert.equal(r.body.created, 2);
  const rows = (await owner.get('/contacts?source=CSLB%20LA&industry_type=C-10%20Electrical')).body.rows;
  assert.equal(rows.length, 1);
  const c = (await owner.get(`/contacts/${rows[0].id}`)).body.contact;
  assert.deepEqual([c.company, c.name, c.title, c.license_no, c.business_type, c.city, c.zip, c.county, c.phone_e164, c.other_personnel, c.industry, c.industry_type],
    ['Sunset Electric Inc', 'Ara Hakobyan', 'RMO', '1012345', 'Corporation', 'Glendale', '91203', 'Los Angeles', '+18185550411', 'Nara Hakobyan (CEO)', 'Construction', 'C-10 Electrical']);
  const tsv = 'Business Name\tContact Name\tPhone\tCity\nTab Tile Co\tAni Sargsyan\t(626) 555-0413\tPasadena\n';
  const fd = new FormData(); fd.append('file', new Blob([tsv], { type: 'text/plain' }), 'list.csv');
  assert.equal((await owner.post('/contacts/import?commit=1', fd)).body.created, 1, 'tab-separated text works too');
});

test('texting again: owner can override the waiting period (never opt-out/DNC); undo puts a person back; open-list hint', async () => {
  const t1 = await mk('Test Self', '+17475550901');
  const t2 = await mk('Test Opted', '+17475550902');
  const first = (await owner.post('/phone-texts/batches', { name: 'self test', ids: [t1.id, t2.id] })).body;
  // making it again while it is open points to the open list
  const dup = (await owner.post('/phone-texts/batches', { ids: [t1.id] })).body;
  assert.equal(dup.openListId, first.batch.id);
  for (let i = 0; i < 2; i++) { const n = (await owner.get(`/phone-texts/batches/${first.batch.id}/next`)).body; await owner.post(`/phone-texts/items/${n.item.id}/sent`); }
  await owner.patch(`/contacts/${t2.id}`, { sms_marketing: 'opted_out' });
  const again = (await owner.post('/phone-texts/batches', { ids: [t1.id, t2.id] })).body;
  assert.equal(again.added, 0); assert.equal(again.excluded['Already texted in the last 30 days'], 1);
  assert.equal((await sales.post('/phone-texts/batches', { ids: [t1.id], allowRepeat: true })).status, 403, 'sales cannot override');
  const forced = (await owner.post('/phone-texts/batches', { name: 'self test 2', ids: [t1.id, t2.id], allowRepeat: true })).body;
  assert.equal(forced.added, 1, 'opted-out person stays out even with the override');
  const n = (await owner.get(`/phone-texts/batches/${forced.batch.id}/next`)).body;
  assert.equal(n.item.contact.id, t1.id);
  await owner.post(`/phone-texts/items/${n.item.id}/sent`);
  // "it did not go out": undo returns the person to the list
  assert.equal((await sales.post(`/phone-texts/items/${n.item.id}/undo`)).status, 400, 'only the person who marked it (or owner/admin)');
  assert.equal((await owner.post(`/phone-texts/items/${n.item.id}/undo`)).status, 200);
  const back = (await owner.get(`/phone-texts/batches/${forced.batch.id}/next`)).body;
  assert.equal(back.item.id, n.item.id);
  assert.ok((await owner.get(`/contacts/${t1.id}`)).body.timeline.some(t => /Marked as not sent/.test(t.summary)));
});

test('editing the text in Settings applies to lists already made, line breaks kept', async () => {
  const p = await mk('Paula Lines', '+17475550931');
  const list = (await owner.post('/phone-texts/batches', { name: 'text change', ids: [p.id] })).body;
  const tpl = 'Hi {first_name}, uniforms for {company}.\n\nFree quote: https://dssuniforms.com/pages/get-a-quote\nor call\n(747) 588-7117.\n\nReply STOP and we won\'t text again.';
  assert.equal((await owner.patch('/settings', { phoneText: { template: tpl } })).status, 200);
  const n = (await owner.get(`/phone-texts/batches/${list.batch.id}/next`)).body;
  assert.equal(n.item.body, 'Hi Paula, uniforms for Paula Lines Builders.\n\nFree quote: https://dssuniforms.com/pages/get-a-quote\nor call\n(747) 588-7117.\n\nReply STOP and we won\'t text again.');
});

test('send a finished list again: same people in a new numbered list, owner/admin only, opt-outs still out', async () => {
  const a = await mk('Again One', '+17475550941'); const b = await mk('Again Two', '+17475550942');
  const l = (await owner.post('/phone-texts/batches', { name: 'Again test', ids: [a.id, b.id] })).body.batch;
  for (let i = 0; i < 2; i++) { const n = (await owner.get(`/phone-texts/batches/${l.id}/next`)).body; await owner.post(`/phone-texts/items/${n.item.id}/sent`); }
  assert.equal((await sales.post(`/phone-texts/batches/${l.id}/again`)).status, 403);
  await owner.patch(`/contacts/${b.id}`, { sms_marketing: 'opted_out' });
  const r = (await owner.post(`/phone-texts/batches/${l.id}/again`)).body;
  assert.equal(r.batch.name, 'Again test (2)'); assert.equal(r.added, 2);
  const n = (await owner.get(`/phone-texts/batches/${r.batch.id}/next`)).body;
  assert.equal(n.item.contact.id, a.id);
  await owner.post(`/phone-texts/items/${n.item.id}/sent`);
  const done = (await owner.get(`/phone-texts/batches/${r.batch.id}/next`)).body;
  assert.equal(done.done, true); assert.equal(done.counts.skipped, 1, 'the opted-out person was skipped at send time');
  assert.equal((await owner.post(`/phone-texts/batches/${r.batch.id}/again`)).body.batch.name, 'Again test (3)');
  const lists = (await owner.get('/phone-texts/batches')).body;
  assert.ok(lists.find(x => x.id === l.id).closed_at, 'the old list is closed, still shown with its results');
});

test('merged customers: lists follow the merge to the record in use now', async () => {
  const old1 = await mk('Merge Old', '+17475550951');
  const keep = await mk('Merge Keep', '+17475550952');
  const l = (await owner.post('/phone-texts/batches', { name: 'merge test', ids: [old1.id] })).body.batch;
  const n = (await owner.get(`/phone-texts/batches/${l.id}/next`)).body; await owner.post(`/phone-texts/items/${n.item.id}/sent`);
  await owner.post('/contacts/merge', { into: keep.id, from: old1.id });
  const again = (await owner.post(`/phone-texts/batches/${l.id}/again`)).body;
  assert.equal(again.added, 1);
  const n2 = (await owner.get(`/phone-texts/batches/${again.batch.id}/next`)).body;
  assert.equal(n2.item.contact.id, keep.id);
  // a list made before the merge also follows it at send time
  const a = await mk('Merge A', '+17475550953'); const b2 = await mk('Merge B', '+17475550954');
  const l2 = (await owner.post('/phone-texts/batches', { name: 'merge later', ids: [a.id] })).body.batch;
  await owner.post('/contacts/merge', { into: b2.id, from: a.id });
  const n3 = (await owner.get(`/phone-texts/batches/${l2.id}/next`)).body;
  assert.equal(n3.item.contact.id, b2.id);
});
