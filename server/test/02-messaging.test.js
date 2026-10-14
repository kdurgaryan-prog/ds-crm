import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, makeBusiness, startServer, stopServer, login, connectChannel, twilioPost, publicFetch, drainJobs, fakeTransport, fakeLLM, text, withBiz, withSystem } from './helpers.js';

const TOKEN = 'twilio-test-token';
let biz, owner, sales, sent;
before(async () => {
  await resetDb();
  biz = await makeBusiness();
  await connectChannel(biz, 'sms', { phoneNumber: '+12135550100' }, { accountSid: 'ACtest', authToken: TOKEN });
  await connectChannel(biz, 'whatsapp', { whatsappNumber: '+12135550100' }, { accountSid: 'ACtest', authToken: TOKEN });
  await connectChannel(biz, 'messenger', { pageId: 'PAGE1' }, { pageAccessToken: 'pat', appSecret: 'meta-secret', verifyToken: 'vt' });
  await startServer();
  owner = await login('owner@ds-systems.test'); sales = await login('sales@ds-systems.test');
});
after(stopServer);
beforeEach(() => { sent = fakeTransport(); fakeLLM(() => text('Thanks! What quantity do you need?')); });

const sms = (from, body, sid = 'SM' + crypto.randomBytes(8).toString('hex')) => twilioPost('/webhooks/twilio/messaging', { MessageSid: sid, From: from, To: '+12135550100', Body: body, NumMedia: '0' }, TOKEN);

test('inbound SMS creates the customer, conversation and timeline entry', async () => {
  const r = await sms('+13235550104', 'Do you embroider hoodies?', 'SM_first');
  assert.equal(r.status, 200);
  const inbox = await sales.get('/inbox');
  assert.equal(inbox.body.total, 1);
  const cv = inbox.body.rows[0];
  assert.equal(cv.channel, 'sms'); assert.equal(cv.needs_reply, true); assert.equal(cv.phone_e164, '+13235550104');
  const card = await sales.get(`/contacts/${cv.contact_id}`);
  assert.equal(card.body.contact.source, 'sms');
  assert.ok(card.body.timeline.some(a => /SMS from customer/.test(a.summary)));
});

test('provider retries of the same message are ignored; bad signatures are rejected', async () => {
  await sms('+13235550104', 'Do you embroider hoodies?', 'SM_first');
  const t = await withBiz(biz.id, c => c.query(`select count(*)::int n from messages where provider_message_id = 'SM_first'`));
  assert.equal(t.rows[0].n, 1);
  const bad = await publicFetch('/webhooks/twilio/messaging', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged' }, body: new URLSearchParams({ MessageSid: 'SMx', From: '+13235550199', To: '+12135550100', Body: 'hi' }) });
  assert.equal(bad.status, 403);
});

test('staff reply goes out on the same channel exactly once and pauses the AI', async () => {
  const cv = (await sales.get('/inbox')).body.rows[0];
  await withBiz(biz.id, c => c.query(`update jobs set status = 'canceled' where kind = 'natalie.reply'`));
  const fd = () => { const f = new FormData(); f.append('body', 'Yes! How many and what colors?'); return f; };
  const r1 = await sales.post(`/inbox/${cv.id}/reply`, fd(), { 'idempotency-key': 'k1' });
  const r2 = await sales.post(`/inbox/${cv.id}/reply`, fd(), { 'idempotency-key': 'k1' }); // double click
  assert.equal(r1.status, 201); assert.equal(r2.body.id, r1.body.id);
  await drainJobs(); await drainJobs();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'sms'); assert.equal(sent[0].to, '+13235550104');
  const th = await sales.get(`/inbox/${cv.id}`);
  const out = th.body.messages.find(m => m.direction === 'out');
  assert.equal(out.status, 'sent'); assert.ok(out.provider_message_id);
  assert.equal(th.body.conversation.ai_enabled, false);
});

test('a re-queued delivery job never sends a message twice', async () => {
  const msg = (await withBiz(biz.id, c => c.query(`select id from messages where direction = 'out' limit 1`))).rows[0];
  await withBiz(biz.id, c => c.query(`insert into jobs (business_id, kind, payload) values ($1, 'message.send', $2)`, [biz.id, { messageId: msg.id }]));
  await drainJobs();
  assert.equal(sent.length, 0);
});

test('Twilio status callbacks update delivery; failure is shown, not hidden', async () => {
  const m = (await withBiz(biz.id, c => c.query(`select * from messages where direction = 'out' limit 1`))).rows[0];
  await twilioPost('/webhooks/twilio/message-status', { MessageSid: m.provider_message_id, MessageStatus: 'undelivered', ErrorCode: '30003', From: '+12135550100', To: '+13235550104' }, TOKEN);
  const after = (await withBiz(biz.id, c => c.query(`select status, status_detail from messages where id = $1`, [m.id]))).rows[0];
  assert.equal(after.status, 'failed'); assert.match(after.status_detail, /30003/);
});

test('provider outage: retried with backoff, then delivered; permanent failure lands in Failed actions', async () => {
  sent = fakeTransport({ fail: 1, retryable: true });
  const cv = (await sales.get('/inbox')).body.rows[0];
  const f = new FormData(); f.append('body', 'Following up');
  const r = await sales.post(`/inbox/${cv.id}/reply`, f);
  await drainJobs(1); // one pass: the first attempt fails and is rescheduled
  let m = (await withBiz(biz.id, c => c.query('select status, status_detail from messages where id = $1', [r.body.id]))).rows[0];
  assert.equal(m.status, 'queued'); assert.match(m.status_detail, /Retrying/);
  await drainJobs();
  m = (await withBiz(biz.id, c => c.query('select status from messages where id = $1', [r.body.id]))).rows[0];
  assert.equal(m.status, 'sent'); assert.equal(sent.length, 1);

  sent = fakeTransport({ fail: 99, retryable: false });
  const f2 = new FormData(); f2.append('body', 'This one fails');
  const r2 = await sales.post(`/inbox/${cv.id}/reply`, f2);
  await drainJobs();
  const m2 = (await withBiz(biz.id, c => c.query('select status from messages where id = $1', [r2.body.id]))).rows[0];
  assert.equal(m2.status, 'failed');
  const failed = await owner.get('/settings/jobs?status=dead');
  assert.ok(failed.body.rows.some(j => j.kind === 'message.send'));
  // fix the provider, retry from the queue → delivered
  sent = fakeTransport();
  const job = failed.body.rows.find(j => j.payload.messageId === r2.body.id);
  assert.equal((await owner.post(`/settings/jobs/${job.id}/retry`)).status, 200);
  await drainJobs();
  assert.equal(sent.length, 1);
});

test('unconnected channel: message is failed with a plain reason, never shown as sent', async () => {
  await withBiz(biz.id, c => c.query(`update channel_accounts set status = 'needs_setup' where channel = 'sms'`));
  const cv = (await sales.get('/inbox')).body.rows[0];
  const f = new FormData(); f.append('body', 'Hello?');
  const r = await sales.post(`/inbox/${cv.id}/reply`, f);
  await drainJobs();
  const m = (await withBiz(biz.id, c => c.query('select status, status_detail from messages where id = $1', [r.body.id]))).rows[0];
  assert.equal(m.status, 'failed'); assert.match(m.status_detail, /not connected/);
  assert.equal(sent.length, 0);
  await withBiz(biz.id, c => c.query(`update channel_accounts set status = 'connected' where channel = 'sms'`));
});

test('STOP opts the customer out; further texts are blocked; START opts back in', async () => {
  await sms('+13235550104', 'STOP');
  const ct = (await withBiz(biz.id, c => c.query(`select * from contacts where phone_e164 = '+13235550104'`))).rows[0];
  assert.ok(ct.opted_out_at); assert.equal(ct.sms_marketing, 'opted_out');
  const cv = (await sales.get('/inbox')).body.rows[0];
  const f = new FormData(); f.append('body', 'One more thing');
  const r = await sales.post(`/inbox/${cv.id}/reply`, f);
  assert.equal(r.status, 422); assert.match(r.body.error, /Opted out/);
  await drainJobs();
  assert.equal(sent.length, 0);
  await sms('+13235550104', 'START');
  const again = (await withBiz(biz.id, c => c.query(`select opted_out_at from contacts where id = $1`, [ct.id]))).rows[0];
  assert.equal(again.opted_out_at, null);
});

test('"please stop texting me" counts as an opt-out too', async () => {
  await sms('+13235550177', 'please stop texting me');
  const ct = (await withBiz(biz.id, c => c.query(`select opted_out_at from contacts where phone_e164 = '+13235550177'`))).rows[0];
  assert.ok(ct.opted_out_at);
});

test('WhatsApp: inbound works; replies after 24h are blocked unless a template is used', async () => {
  await twilioPost('/webhooks/twilio/messaging', { MessageSid: 'SMwa1', From: 'whatsapp:+18185550103', To: 'whatsapp:+12135550100', Body: 'Hola', ProfileName: 'Ani', NumMedia: '0' }, TOKEN);
  const cv = (await sales.get('/inbox?channel=whatsapp')).body.rows[0];
  assert.equal(cv.contact_name, 'Ani');
  await withBiz(biz.id, c => c.query(`update conversations set last_inbound_at = now() - interval '30 hours' where id = $1`, [cv.id]));
  const f = new FormData(); f.append('body', 'Hi Ani');
  const r = await sales.post(`/inbox/${cv.id}/reply`, f);
  assert.equal(r.status, 422); assert.match(r.body.error, /template/i);
});

test('Messenger webhook: signature checked, message routed to the right business', async () => {
  const payload = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID9' }, recipient: { id: 'PAGE1' }, message: { mid: 'mid.1', text: 'Need 50 polos' } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'meta-secret').update(payload).digest('hex');
  const bad = await publicFetch('/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: payload });
  assert.equal(bad.status, 403);
  const ok = await publicFetch('/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
  assert.equal(ok.status, 200);
  await publicFetch('/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload }); // retry
  const rows = (await sales.get('/inbox?channel=messenger')).body.rows;
  assert.equal(rows.length, 1);
  const n = (await withBiz(biz.id, c => c.query(`select count(*)::int n from messages where provider_message_id = 'mid.1'`))).rows[0].n;
  assert.equal(n, 1);
  // verify handshake
  const hs = await publicFetch('/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42');
  assert.equal(await hs.text(), '42');
});

test('website chat and quote form land in the same CRM; bots and other sites are refused', async () => {
  const key = biz.public_key;
  const s = await (await publicFetch(`/api/public/${key}/chat/session`, { method: 'POST', headers: { origin: 'https://dssuniforms.com' } })).json();
  assert.match(s.greeting, /AI assistant/);
  const m = await publicFetch(`/api/public/${key}/chat/messages`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dssuniforms.com' }, body: JSON.stringify({ visitorId: s.visitorId, token: s.token, text: 'Do you print on vests?' }) });
  assert.equal(m.status, 200);
  const forged = await publicFetch(`/api/public/${key}/chat/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorId: s.visitorId, token: 'x'.repeat(20), text: 'hi' }) });
  assert.equal(forged.status, 403);
  const form = await publicFetch(`/api/public/${key}/forms`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dssuniforms.com' }, body: JSON.stringify({ name: 'Rob', company: 'FastLane', phone: '(562) 555-0106', product_type: 'Hats', quantity: 100, decoration: 'Embroidery', form: 'quote' }) });
  assert.equal(form.status, 200);
  const bot = await publicFetch(`/api/public/${key}/forms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bot', phone: '(562) 555-0199', website: 'spam' }) });
  assert.equal(bot.status, 200);
  const lead = (await sales.get('/contacts?q=FastLane')).body.rows[0];
  assert.equal(lead.source, 'website_quote'); assert.equal(lead.quantity, 100);
  assert.equal((await sales.get('/contacts?q=Bot')).body.total, 0);
  assert.ok((await sales.get('/inbox?channel=website_forms')).body.rows.length === 1);
  assert.ok((await sales.get('/inbox?channel=webchat')).body.rows.length === 1);
  const chans = (await owner.get('/settings/channels')).body;
  assert.equal(chans.find(c => c.channel === 'webchat').status, 'connected');
  assert.equal(chans.find(c => c.channel === 'website_forms').status, 'connected');
});

test('channels never show connected without a real check; missing AI key shows needs setup', async () => {
  const r = await owner.put('/settings/channels/instagram', { config: { igAccountId: '1789' }, secrets: { appSecret: 's' } });
  assert.equal(r.body.status, 'needs_setup');
  const list = (await owner.get('/settings/channels')).body;
  assert.equal(list.find(c => c.channel === 'instagram').status, 'needs_setup');
  assert.match(list.find(c => c.channel === 'instagram').lastError, /pageAccessToken/);
  assert.equal(list.find(c => c.channel === 'ai').status, 'needs_setup');
  // secrets are never returned to the browser
  assert.equal(JSON.stringify(list).includes(TOKEN), false);
});


test('regression: typing someone else\'s phone into website chat does not reveal or attach their record', async () => {
  const key = biz.public_key;
  const s = await (await publicFetch(`/api/public/${key}/chat/session`, { method: 'POST' })).json();
  await publicFetch(`/api/public/${key}/chat/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorId: s.visitorId, token: s.token, text: 'what did I order?', phone: '(562) 555-0106' }) });
  const real = (await sales.get('/contacts?q=FastLane')).body.rows[0];
  const card = (await sales.get(`/contacts/${real.id}`)).body;
  assert.equal(card.conversations.some(c => c.channel === 'webchat'), false);
  const dupes = (await owner.get('/contacts/duplicates')).body;
  assert.ok(dupes.some(d => /Website chat visitor typed a phone/.test(d.reason)));
});

test('existing dssuniforms.com "Get a Quote" form: the theme webhook payload becomes a full lead', async () => {
  // exactly what dss.js sends with navigator.sendBeacon (text/plain JSON, keys without "contact[...]")
  const payload = {
    form_type: 'contact', utf8: '✓', tags: 'quote', Form: 'Get a Quote', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fall', utm_content: '',
    name: 'Carlos Medina', Company: 'Medina Roofing', email: 'carlos@example.com', phone: '(818) 555-0144',
    'Product: Polos': 'Yes', 'Product: Safety Vests': 'Yes', 'Location: Left chest': 'Yes', 'Location: Back': 'Yes',
    Quantity: '45', Decoration: 'Not sure yet', 'Preferred date': '2026-11-20', Budget: '$10–$20', body: 'Logo is orange, need hi-vis', page: 'https://dssuniforms.com/pages/get-a-quote',
  };
  const r = await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://dssuniforms.com' }, body: JSON.stringify(payload) });
  assert.equal(r.status, 204);
  const lead = (await sales.get('/contacts?q=Medina')).body.rows[0];
  assert.equal(lead.name, 'Carlos Medina'); assert.equal(lead.company, 'Medina Roofing'); assert.equal(lead.phone_e164, '+18185550144');
  assert.equal(lead.product_type, 'Polos, Safety Vests'); assert.equal(lead.quantity, 45); assert.equal(lead.decoration, 'Not sure');
  assert.equal(lead.deadline, '2026-11-20'); assert.equal(lead.source, 'website_quote'); assert.equal(lead.email, 'carlos@example.com');
  const card = (await sales.get(`/contacts/${lead.id}`)).body;
  const cv = card.conversations.find(c => c.channel === 'website_forms');
  const msg = (await sales.get(`/inbox/${cv.id}`)).body.messages[0].body;
  for (const part of ['Print locations: Left chest, Back', 'Budget per piece', 'Came from: google / cpc / fall', 'Notes: Logo is orange']) assert.match(msg, new RegExp(part.replace(/[/]/g, '\\/')));
  assert.ok(card.tasks.some(t => /Respond to website quote request/.test(t.title)));
  // the same person submitting again updates the same customer, no duplicate
  await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...payload, Quantity: '60' }) });
  assert.equal((await sales.get('/contacts?q=Medina')).body.total, 1);
  // garbage is refused
  assert.equal((await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json' })).status, 400);
  assert.equal((await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'x', phone: '12' }) })).status, 400);
});

test('SMS opt-in: texting the keyword records consent with proof, confirms, and sends Natalie\'s intro — no AI call needed', async () => {
  await drainJobs(); sent = fakeTransport(); // finish work left by earlier tests (e.g. a Messenger reply) first
  const calls = fakeLLM(() => text('should not be used'));
  await sms('+16195550150', 'Uniform!', 'SMkw1');
  await drainJobs();
  const ct = (await withBiz(biz.id, c => c.query(`select * from contacts where phone_e164 = '+16195550150'`))).rows[0];
  assert.equal(ct.sms_marketing, 'opted_in'); assert.match(ct.sms_consent_source, /keyword "UNIFORM"/); assert.ok(ct.sms_consent_at);
  const out = sent.filter(m => m.to === '+16195550150').map(m => m.body);
  assert.equal(out.length, 2);
  assert.match(out[0], /Msg & data rates may apply.*STOP/);
  assert.match(out[1], /I'm Natalie, ai agent/); assert.match(out[1], /dssuniforms\.com\/pages\/get-a-quote/); assert.doesNotMatch(out[1], /timlss|timeless/i);
  assert.equal(calls.length, 0);
  assert.ok((await owner.get('/agents/actions?agent=natalie')).body.some(a => a.action === 'intro_sms' && a.based_on.consent.includes('UNIFORM')));
  // HELP gets the help text; STOP afterwards blocks everything
  await sms('+16195550150', 'HELP', 'SMkw2'); await drainJobs();
  assert.match(sent.at(-1).body, /Reply STOP to opt out/);
  await sms('+16195550150', 'STOP', 'SMkw3'); await drainJobs();
  assert.equal((await sales.post(`/contacts/${ct.id}/intro-sms`)).status, 400);
});

test('SMS opt-in: website request with the SMS box ticked gets the intro text; without the box, no text', async () => {
  const base = { name: 'Lena Park', Company: 'Park Bakery', email: 'lena@example.com', 'Product: Aprons': 'Yes', Quantity: '30', Decoration: 'Embroidery' };
  await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...base, phone: '(619) 555-0160', 'SMS consent': 'Yes' }) });
  await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...base, name: 'No Box', phone: '(619) 555-0161' }) });
  await drainJobs();
  assert.equal(sent.filter(m => m.to === '+16195550160').length, 1);
  assert.equal(sent.filter(m => m.to === '+16195550161').length, 0);
  const yes = (await sales.get('/contacts?q=555-0160')).body.rows[0];
  assert.equal(yes.sms_marketing, 'opted_in');
  const card = (await sales.get(`/contacts/${yes.id}`)).body.contact;
  assert.match(card.sms_consent_source, /website quote form checkbox/);
  // same request again doesn't send a second intro
  await publicFetch(`/api/public/${biz.public_key}/shopify-quote`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ...base, phone: '(619) 555-0160', 'SMS consent': 'Yes' }) });
  await drainJobs();
  assert.equal(sent.filter(m => m.to === '+16195550160').length, 1);
});

test('SMS opt-in: staff can send the intro only after recording agreement; the text is editable but must keep STOP', async () => {
  await withBiz(biz.id, c => c.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"00:00","end":"23:59","timezone":"America/Los_Angeles","days":[1,2,3,4,5,6,7]}') where id = $1`, [biz.id]));
  const c = (await sales.post('/contacts', { name: 'Tom Reyes', phone: '(619) 555-0170', timezone: 'America/Los_Angeles' })).body.contact;
  const no = await sales.post(`/contacts/${c.id}/intro-sms`);
  assert.equal(no.status, 400); assert.match(no.body.error, /No SMS consent/);
  await sales.patch(`/contacts/${c.id}`, { sms_marketing: 'opted_in' });
  assert.match((await sales.get(`/contacts/${c.id}`)).body.contact.sms_consent_source, /recorded by/);
  assert.equal((await owner.patch('/settings', { sms: { introText: 'Hi {first_name}, Natalie (AI) from DS Systems here.' } })).status, 400);
  assert.equal((await owner.patch('/settings', { sms: { introText: 'Hi {first_name}, Natalie (AI) from DS Systems here. Reply STOP to opt out.', keywords: ['uniform', 'stop', 'Polo'] } })).status, 200);
  assert.deepEqual((await owner.get('/settings')).body.settings.sms.keywords, ['UNIFORM', 'POLO']);
  const r = await sales.post(`/contacts/${c.id}/intro-sms`);
  assert.equal(r.status, 201);
  await drainJobs();
  assert.equal(sent.filter(m => m.to === '+16195550170')[0].body, 'Hi Tom, Natalie (AI) from DS Systems here. Reply STOP to opt out.');
});
