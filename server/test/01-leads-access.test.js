import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeBusiness, startServer, stopServer, login, withBiz, pool } from './helpers.js';

let biz, other, owner, sales, viewer, marketing, otherOwner;
before(async () => {
  await resetDb();
  biz = await makeBusiness();
  other = await makeBusiness('other-biz', 'Another Business');
  await startServer();
  owner = await login('owner@ds-systems.test'); sales = await login('sales@ds-systems.test');
  viewer = await login('viewer@ds-systems.test'); marketing = await login('marketing@ds-systems.test');
  otherOwner = await login('owner@other-biz.test');
});
after(stopServer);

test('lead creation numbers leads sequentially and normalizes phone', async () => {
  const a = await sales.post('/contacts', { name: 'Maria Lopez', company: 'Lopez Construction', phone: '(213) 555-0101', product_type: 'Safety vests', quantity: 60 });
  assert.equal(a.status, 201);
  assert.equal(a.body.contact.lead_no, 1);
  assert.equal(a.body.contact.phone_e164, '+12135550101');
  const b = await sales.post('/contacts', { name: 'Daniel Kim', phone: '213.555.0102' });
  assert.equal(b.body.contact.lead_no, 2);
});

test('invalid phone returns a field error with a recovery hint', async () => {
  const r = await sales.post('/contacts', { name: 'X', phone: '12' });
  assert.equal(r.status, 400);
  assert.ok(r.body.hint);
  assert.equal(r.body.details[0].field, 'phone');
});

test('same normalized phone returns the existing customer instead of a duplicate', async () => {
  const r = await sales.post('/contacts', { name: 'M. Lopez', phone: '+1 213 555 0101' });
  assert.equal(r.status, 200);
  assert.equal(r.body.existing, true);
  assert.equal(r.body.contact.lead_no, 1);
  const list = await owner.get('/contacts?q=Lopez');
  assert.equal(list.body.total, 1);
});

test('same name with a different phone is flagged for review, not merged', async () => {
  const r = await sales.post('/contacts', { name: 'Maria Lopez', phone: '(213) 555-0199' });
  assert.equal(r.status, 201);
  assert.equal(r.body.contact.lead_no, 3);
  const d = await owner.get('/contacts/duplicates');
  assert.equal(d.body.length, 1);
  assert.match(d.body[0].reason, /same name/);
});

test('search works by phone digits, lead number and company; server paging and filters', async () => {
  assert.equal((await owner.get('/contacts?q=555-0102')).body.rows[0].lead_no, 2);
  assert.equal((await owner.get('/contacts?q=lead%202')).body.rows[0].lead_no, 2);
  assert.equal((await owner.get('/contacts?q=construction')).body.total, 1);
  for (let i = 0; i < 60; i++) await sales.post('/contacts', { name: `Bulk ${i}`, phone: `(310) 555-${String(1000 + i)}`, source: 'import', quantity: i });
  const p1 = await owner.get('/contacts?size=25&page=1&sort=lead_no&dir=asc');
  assert.equal(p1.body.rows.length, 25);
  assert.equal(p1.body.rows[0].lead_no, 1);
  const p3 = await owner.get('/contacts?size=25&page=3&sort=lead_no&dir=asc');
  assert.equal(p3.body.rows.length, 63 - 50);
  const f = await owner.get('/contacts?source=import&qty_min=10&qty_max=19');
  assert.equal(f.body.total, 10);
});

test('merge moves history, keeps the strictest permissions, and resolves the review item', async () => {
  const d = (await owner.get('/contacts/duplicates')).body[0];
  const keep = d.a.lead_no < d.b.lead_no ? d.a : d.b; const drop = keep === d.a ? d.b : d.a;
  await sales.patch(`/contacts/${drop.id}`, { dnc: true });
  await sales.post(`/contacts/${drop.id}/notes`, { text: 'Prefers navy' });
  const m = await sales.post('/contacts/merge', { into: keep.id, from: drop.id });
  assert.equal(m.status, 200);
  assert.equal(m.body.dnc, true);
  const card = await owner.get(`/contacts/${keep.id}`);
  assert.ok(card.body.timeline.some(a => a.summary === 'Prefers navy'));
  assert.ok(card.body.timeline.some(a => a.kind === 'merge'));
  assert.equal((await owner.get('/contacts/duplicates')).body.length, 0);
  // the merged-away record redirects to the kept one
  assert.equal((await owner.get(`/contacts/${drop.id}`)).body.contact.id, keep.id);
});

test('roles: viewer reads but cannot write; marketing cannot open the inbox; sales cannot export', async () => {
  assert.equal((await viewer.get('/contacts')).status, 200);
  const w = await viewer.post('/contacts', { name: 'Nope', phone: '2135550111' });
  assert.equal(w.status, 403);
  assert.ok(w.body.hint);
  assert.equal((await marketing.get('/inbox')).status, 403);
  assert.equal((await sales.get('/contacts/export.csv')).status, 403);
  assert.equal((await sales.patch('/agents/natalie', { enabled: false })).status, 403);
  assert.equal((await owner.get('/contacts/export.csv')).status, 200);
});

test('businesses are fully separated (API and database level)', async () => {
  const mine = (await owner.get('/contacts?q=Lopez')).body.rows[0];
  assert.equal((await otherOwner.get(`/contacts/${mine.id}`)).status, 404);
  assert.equal((await otherOwner.get('/contacts')).body.total, 0);
  // same phone in another business is a different customer there
  const r = await otherOwner.post('/contacts', { name: 'Someone', phone: '(213) 555-0101' });
  assert.equal(r.status, 201);
  assert.equal(r.body.contact.lead_no, 1);
  // row-level security: a query scoped to the other business cannot see this business' rows
  const seen = await withBiz(other.id, c => c.query('select count(*)::int n from contacts where business_id = $1', [biz.id]));
  assert.equal(seen.rows[0].n, 0);
  // and with no business set, the app role sees nothing at all
  const none = await pool.query('select count(*)::int n from contacts');
  assert.equal(none.rows[0].n, 0);
});

test('regression: each business sees only its own team (users list, assignee pickers)', async () => {
  const mine = (await owner.get('/settings/users')).body.map(u => u.email);
  assert.ok(mine.every(e => e.endsWith('@ds-systems.test')));
  const facetUsers = (await owner.get('/contacts/facets')).body.users;
  assert.equal(facetUsers.length, 5);
  const theirs = (await otherOwner.get('/settings/users')).body.map(u => u.email);
  assert.ok(theirs.every(e => e.endsWith('@other-biz.test')));
});

test('CSRF guard blocks state changes without the app header', async () => {
  const r = await owner.raw('POST', '/contacts', { name: 'x' }, { 'x-requested-with': 'nope' });
  assert.equal(r.status, 403);
});

test('import previews without writing, then commits; existing phones update blanks only', async () => {
  const csv = 'Name,Company,Phone,Product,Quantity\nNew Person,ACME,(626) 555-0120,Polos,30\nDaniel Kim,Seoul Kitchen,213-555-0102,,\nBad Row,,12,,\n';
  const mk = () => { const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'c.csv'); return fd; };
  const before = (await owner.get('/contacts')).body.total;
  const p = await owner.post('/contacts/import', mk());
  assert.equal(p.body.created, 1); assert.equal(p.body.updated, 1); assert.equal(p.body.invalid.length, 1);
  assert.equal((await owner.get('/contacts')).body.total, before);
  const c = await owner.post('/contacts/import?commit=1', mk());
  assert.equal(c.body.committed, true);
  assert.equal((await owner.get('/contacts')).body.total, before + 1);
  assert.equal((await owner.get('/contacts?q=555-0102')).body.rows[0].company, 'Seoul Kitchen');
});

test('soft delete can be undone', async () => {
  const c = (await owner.get('/contacts?q=New%20Person')).body.rows[0];
  assert.equal((await owner.del(`/contacts/${c.id}`)).status, 200);
  assert.equal((await owner.get(`/contacts/${c.id}`)).status, 404);
  await owner.post(`/contacts/${c.id}/restore`);
  assert.equal((await owner.get(`/contacts/${c.id}`)).status, 200);
});
