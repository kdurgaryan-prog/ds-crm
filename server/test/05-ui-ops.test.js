import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resetDb, makeBusiness, startServer, stopServer, login, publicFetch, withBiz, withSystem, PASSWORD } from './helpers.js';
import { checkLinks } from '../src/routes/settings.js';
import { config, deliveryIsLive } from '../src/config.js';

let biz, owner, admin, sales, viewer;
before(async () => {
  await resetDb();
  biz = await makeBusiness();
  await startServer();
  [owner, admin, sales, viewer] = await Promise.all(['owner', 'admin', 'sales', 'viewer'].map(r => login(`${r}@ds-systems.test`)));
});
after(stopServer);

const view = { name: 'My sales view', config: { columns: [{ key: 'company', width: 260 }, { key: 'lead_no', width: 80 }, { key: 'email', hidden: true, width: 150 }], rowHeight: 34, wrapHeaders: true, sort: 'deadline', dir: 'asc' }, is_default: true };

test('table layout: save a personal view, load it back, change it, reset by deleting', async () => {
  const s = await sales.post('/settings/views/contacts', view);
  assert.equal(s.status, 201);
  const list = (await sales.get('/settings/views/contacts')).body;
  assert.equal(list.length, 1); assert.equal(list[0].config.columns[0].key, 'company'); assert.equal(list[0].config.columns[0].width, 260); assert.equal(list[0].config.rowHeight, 34);
  // private to the person who saved it
  assert.equal((await viewer.get('/settings/views/contacts')).body.length, 0);
  const u = await sales.put(`/settings/views/contacts/${s.body.id}`, { config: { ...view.config, rowHeight: 58 } });
  assert.equal(u.body.config.rowHeight, 58);
  assert.equal((await viewer.del(`/settings/views/contacts/${s.body.id}`)).status, 403);
  assert.equal((await sales.del(`/settings/views/contacts/${s.body.id}`)).status, 200);
  assert.equal((await sales.get('/settings/views/contacts')).body.length, 0);
});

test('shared views: only owner/admin can publish one for everyone', async () => {
  assert.equal((await sales.post('/settings/views/contacts', { ...view, shared: true })).status, 403);
  assert.equal((await admin.post('/settings/views/contacts', { ...view, name: 'Team view', shared: true, is_default: false })).status, 201);
  assert.equal((await viewer.get('/settings/views/contacts')).body[0].name, 'Team view');
});

test('personal look: font, size, weight, colors, density, theme are saved per person and validated', async () => {
  const p = { fontFamily: 'serif', fontSize: 18, fontWeight: 500, accent: '#225588', textColor: '#111111', density: 'spacious', theme: 'dark' };
  assert.equal((await sales.put('/settings/prefs', p)).status, 200);
  assert.deepEqual((await sales.get('/auth/me')).body.prefs, p);
  assert.deepEqual((await owner.get('/auth/me')).body.prefs, {});
  assert.equal((await sales.put('/settings/prefs', { accent: 'red; background:url(x)' })).status, 400);
  assert.equal((await sales.put('/settings/prefs', {})).status, 200); // reset to original
  assert.deepEqual((await sales.get('/auth/me')).body.prefs, {});
});

test('custom fields appear on customers and can be filled', async () => {
  const f = await owner.post('/settings/fields', { label: 'Tax exempt', type: 'checkbox' });
  assert.equal(f.body.key, 'tax_exempt');
  const c = await sales.post('/contacts', { name: 'Field Test', phone: '(213) 555-0501', custom: { tax_exempt: true } });
  assert.equal(c.body.contact.custom.tax_exempt, true);
  assert.equal((await sales.get('/contacts/facets')).body.customFields[0].label, 'Tax exempt');
  assert.equal((await sales.post('/settings/fields', { label: 'X', type: 'text' })).status, 403);
});

test('business settings: validation keeps bad input out; changes are audited', async () => {
  assert.equal((await owner.patch('/settings', { campaignHours: { start: '18:00', end: '09:00' } })).status, 400);
  assert.equal((await owner.patch('/settings', { links: { quotePage: 'not a url' } })).status, 400);
  assert.equal((await owner.patch('/settings', { calls: { handoffNumber: '123' } })).status, 400);
  const ok = await owner.patch('/settings', { moq: { minQty: 24 }, calls: { handoffNumber: '(213) 555-0199' } });
  assert.equal(ok.body.moq.minQty, 24); assert.equal(ok.body.calls.handoffNumber, '+12135550199');
  assert.equal((await sales.patch('/settings', { moq: { minQty: 1 } })).status, 403);
  const audit = (await owner.get('/settings/audit')).body;
  assert.ok(audit.some(a => a.action === 'settings.update' && a.before.moq.minQty === 20 && a.after.moq.minQty === 24));
  await owner.patch('/settings', { moq: { minQty: 20 } });
});

test('Natalie\'s quote links are checked for real and the result is shown', async () => {
  const fake = async url => ({ ok: !url.includes('broken'), status: url.includes('broken') ? 404 : 200 });
  await owner.patch('/settings', { links: { quotePage: 'https://dssuniforms.com/pages/broken-quote', contactPage: 'https://dssuniforms.com/pages/get-a-quote' } });
  const res = await withBiz(biz.id, c => checkLinks(c, biz.id, fake));
  assert.equal(res['https://dssuniforms.com/pages/broken-quote'].ok, false);
  const s = (await owner.get('/settings')).body.settings.links.checks;
  assert.equal(s['https://dssuniforms.com/pages/get-a-quote'].status, 200);
});

test('team: add a person with a temporary password, change role, deactivate (signs them out)', async () => {
  const r = await owner.post('/settings/users', { name: 'New Rep', email: 'rep@ds-systems.test', role: 'sales' });
  assert.equal(r.status, 201); assert.ok(r.body.tempPassword.length >= 10);
  assert.equal((await admin.post('/settings/users', { name: 'Boss', email: 'boss@x.test', role: 'owner' })).status, 403);
  const v = (await owner.get('/settings/users')).body.find(u => u.role === 'viewer');
  assert.equal((await owner.patch(`/settings/users/${v.id}`, { active: false })).status, 200);
  assert.equal((await viewer.get('/contacts')).status, 401);
  const me = (await owner.get('/auth/me')).body.user;
  assert.equal((await owner.patch(`/settings/users/${me.id}`, { active: false })).status, 400);
});

test('regression: an admin cannot demote the owner, and deactivation only affects this business', async () => {
  const r = await admin.post('/settings/users', { name: 'x', email: 'owner@ds-systems.test', role: 'admin' });
  assert.equal(r.status, 400);
  assert.equal((await owner.get('/auth/me')).body.user.role, 'owner');
  // a person who belongs to two businesses
  const other = await makeBusiness('second-biz', 'Second Biz');
  const ownerB = await login('owner@second-biz.test');
  const add = await ownerB.post('/settings/users', { name: 'Shared', email: 'sales@ds-systems.test', role: 'viewer' });
  assert.equal(add.status, 201); assert.equal(add.body.tempPassword, undefined);
  const salesId = (await sales.get('/auth/me')).body.user.id;
  await ownerB.patch(`/settings/users/${salesId}`, { active: false });
  assert.equal((await sales.get('/contacts')).status, 200); // still works in DS Systems
  assert.ok(other.id);
});

test('login is rate limited and errors are plain English', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await publicFetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'dscrm' }, body: JSON.stringify({ email: 'owner@ds-systems.test', password: 'wrong' }) });
  assert.equal(last.status, 429);
  assert.match((await last.json()).hint, /15 minutes/);
});

test('file uploads: logos stored and served to signed-in users only; dangerous types refused', async () => {
  const c = (await sales.post('/contacts', { name: 'Logo Co', phone: '(213) 555-0502' })).body.contact;
  const ok = new FormData(); ok.append('kind', 'logo'); ok.append('files', new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')], { type: 'image/svg+xml' }), 'logo.svg');
  const r = await sales.post(`/contacts/${c.id}/files`, ok);
  assert.equal(r.status, 201);
  const got = await sales.raw('GET', `/files/${r.body[0].id}`);
  assert.equal(got.status, 200);
  const anon = await publicFetch(`/api/files/${r.body[0].id}`);
  assert.equal(anon.status, 401);
  const bad = new FormData(); bad.append('files', new Blob(['<script>'], { type: 'text/html' }), 'x.html');
  assert.equal((await sales.post(`/contacts/${c.id}/files`, bad)).status, 400);
});

test('dashboard counts link to the right lists; reports respond', async () => {
  const d = (await sales.get('/dashboard')).body;
  for (const k of ['unanswered', 'missed_calls', 'callbacks', 'overdue_tasks', 'quotes_pending', 'orders_due_soon']) assert.equal(typeof d.counts[k], 'number', k);
  await sales.post('/tasks', { title: 'Overdue thing', due_at: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal((await sales.get('/dashboard')).body.counts.overdue_tasks, 1);
  assert.equal((await sales.get('/tasks?view=overdue')).body.length, 1);
  const rep = (await owner.get('/reports?days=30')).body;
  assert.ok(Array.isArray(rep.leadsBySource) && rep.calls && rep.quotes);
});

test('validation errors keep the details needed to fix the form', async () => {
  const r = await sales.post('/contacts', { name: 'X', email: 'not-an-email', quantity: -5 });
  assert.equal(r.status, 400);
  const fields = r.body.details.map(d => d.field).sort();
  assert.deepEqual(fields, ['email', 'quantity']);
  assert.match(r.body.hint, /kept/);
});

test('staging and test never deliver for real, whatever DELIVERY_MODE says', () => {
  const before = config.deliveryMode;
  config.deliveryMode = 'live';
  assert.equal(deliveryIsLive(), false); // APP_ENV=test
  config.deliveryMode = before;
});

test('backup: real dump + restore test into a scratch database', { skip: !process.env.BACKUP_ADMIN_URL && 'set BACKUP_ADMIN_URL to run' }, async () => {
  const out = execFileSync('bash', ['scripts/backup.sh', '--verify'], { env: { ...process.env, BACKUP_DIR: '/tmp/dscrm-test-backups' }, encoding: 'utf8' });
  assert.match(out, /restore test passed/);
  const run = (await withSystem(c => c.query('select * from backup_runs order by id desc limit 1'))).rows[0];
  assert.equal(run.ok, true); assert.equal(run.verified, true);
  assert.equal((await owner.get('/settings/backups')).body[0].verified, true);
  assert.equal((await admin.get('/settings/backups')).status, 403);
});

test('health check and website widget are served', async () => {
  assert.equal((await publicFetch('/healthz')).status, 200);
  const w = await publicFetch('/widget.js');
  assert.match(await w.text(), /api\/public/);
  assert.equal(PASSWORD.length > 0, true);
});
