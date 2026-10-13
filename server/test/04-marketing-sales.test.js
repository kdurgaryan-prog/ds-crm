import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeBusiness, startServer, stopServer, login, connectChannel, drainJobs, fakeTransport, fakeLLM, text, withBiz } from './helpers.js';
import { withinCampaignHours, checkContactAllowed, classifyKeyword } from '../src/services/compliance.js';

let biz, owner, admin, sales, marketing, viewer, sent;
const HOURS = { start: '09:00', end: '17:00', timezone: 'America/Los_Angeles', days: [1, 2, 3, 4, 5] };
before(async () => {
  await resetDb();
  biz = await makeBusiness();
  await connectChannel(biz, 'sms', { phoneNumber: '+12135550100' }, { accountSid: 'AC1', authToken: 't' });
  await connectChannel(biz, 'instagram', { igAccountId: 'IG1', pageId: 'P1' }, { pageAccessToken: 'x', appSecret: 's', verifyToken: 'v' });
  await connectChannel(biz, 'messenger', { pageId: 'P1' }, { pageAccessToken: 'x', appSecret: 's', verifyToken: 'v' });
  await startServer();
  [owner, admin, sales, marketing, viewer] = await Promise.all(['owner', 'admin', 'sales', 'marketing', 'viewer'].map(r => login(`${r}@ds-systems.test`)));
});
after(stopServer);
beforeEach(() => { sent = fakeTransport(); });

test('campaign hours: LA 9–5 weekdays and the recipient\'s own local hours', () => {
  const at = iso => new Date(iso);
  assert.equal(withinCampaignHours(HOURS, 'America/Los_Angeles', at('2026-10-13T17:00:00Z')).ok, true);   // Tue 10:00 LA
  assert.equal(withinCampaignHours(HOURS, 'America/Los_Angeles', at('2026-10-13T15:00:00Z')).ok, false);  // 08:00 LA
  assert.equal(withinCampaignHours(HOURS, 'America/Los_Angeles', at('2026-10-14T00:30:00Z')).ok, false);  // 17:30 LA
  assert.equal(withinCampaignHours(HOURS, 'America/New_York', at('2026-10-13T22:00:00Z')).ok, false);     // 15:00 LA but 18:00 NY
  assert.equal(withinCampaignHours(HOURS, null, at('2026-10-13T22:00:00Z')).ok, false);                   // unknown → strictest
  assert.equal(withinCampaignHours(HOURS, null, at('2026-10-13T18:00:00Z')).ok, true);                    // 11:00 LA = 14:00 NY
  assert.equal(withinCampaignHours(HOURS, 'America/Los_Angeles', at('2026-10-17T18:00:00Z')).ok, false);  // Saturday
});

test('compliance rules for marketing: consent, DNC, opt-out, written consent for AI calls', () => {
  const tue = new Date('2026-10-13T18:00:00Z');
  const base = { sms_marketing: 'opted_in', call_marketing: 'express_written', dnc: false, opted_out_at: null, timezone: 'America/Los_Angeles' };
  assert.equal(checkContactAllowed({ contact: base, purpose: 'marketing', channel: 'sms', hours: HOURS, now: tue }).allowed, true);
  assert.match(checkContactAllowed({ contact: { ...base, sms_marketing: 'unknown' }, purpose: 'marketing', channel: 'sms', hours: HOURS, now: tue }).reasons[0], /consent/);
  assert.match(checkContactAllowed({ contact: base, dncListed: true, purpose: 'marketing', channel: 'voice', hours: HOURS, now: tue, aiVoice: true }).reasons[0], /Do Not Call/);
  assert.match(checkContactAllowed({ contact: { ...base, call_marketing: 'unknown' }, purpose: 'marketing', channel: 'voice', hours: HOURS, now: tue, aiVoice: true }).reasons.join(), /written consent/);
  assert.equal(checkContactAllowed({ contact: { ...base, opted_out_at: new Date() }, purpose: 'conversational', channel: 'sms', hours: HOURS }).allowed, false);
  assert.equal(classifyKeyword('Stop'), 'opt_out'); assert.equal(classifyKeyword('UNSUBSCRIBE'), 'opt_out'); assert.equal(classifyKeyword('start'), 'opt_in');
  assert.equal(classifyKeyword('can you stop by tomorrow?'), null);
});

let campId;
test('Arev writes a draft from allowed aggregate data only; nothing is published by her', async () => {
  for (const [i, ind] of ['construction', 'construction', 'restaurant'].entries()) await sales.post('/contacts', { name: `C${i}`, phone: `(213) 555-02${10 + i}`, industry: ind, product_type: 'Safety vests', email: `c${i}@example.com` });
  const calls = fakeLLM(() => text('Keep your crew visible and on-brand. Custom hi-vis vests with your logo — DTF printed, ready for the job site. Request a quote today.'));
  const r = await marketing.post('/marketing/arev', { kind: 'social_post', brief: 'Hi-vis vests for construction', channels: ['instagram', 'messenger'] });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'draft'); assert.equal(r.body.created_by_agent, 'arev');
  campId = r.body.id;
  const prompt = calls[0].messages[0].content + calls[0].system;
  assert.match(prompt, /construction/); assert.doesNotMatch(prompt, /\+1213|555-02|example\.com/);
  assert.match(calls[0].system, /Never invent testimonials/);
  const log = (await owner.get('/agents/actions?agent=arev')).body[0];
  assert.equal(log.approval_required, true); assert.deepEqual(log.based_on.aggregates.includes('industry'), true);
});

test('fake social proof in a draft is flagged for the owner', async () => {
  fakeLLM(() => text('"Best uniforms ever!" — Mike, owner of Mike\'s Diner. Trusted by over 500 businesses. 5 stars!'));
  const r = await marketing.post('/marketing/arev', { kind: 'ad_copy', brief: 'restaurants' });
  assert.match(r.body.content.warnings[0], /social proof/);
});

test('Draft → Approval → Publish: only the owner approves, exactly what was previewed', async () => {
  assert.equal((await owner.post(`/marketing/${campId}/start`)).status, 409);             // not approved
  assert.equal((await marketing.post(`/marketing/${campId}/submit`)).status, 200);
  const pv = await owner.get(`/marketing/${campId}/preview`);
  assert.equal(pv.body.preview.channels.length, 2); assert.ok(pv.body.preview.text);
  assert.equal((await admin.post(`/marketing/${campId}/approve`, { hash: pv.body.hash })).status, 403);
  assert.equal((await marketing.post(`/marketing/${campId}/approve`, { hash: pv.body.hash })).status, 403);
  // content changed after preview → approval refused
  await withBiz(biz.id, c => c.query(`update campaigns set content = jsonb_set(content, '{text}', '"changed"') where id = $1`, [campId]));
  assert.equal((await owner.post(`/marketing/${campId}/approve`, { hash: pv.body.hash })).status, 409);
  const pv2 = await owner.get(`/marketing/${campId}/preview`);
  assert.equal((await owner.post(`/marketing/${campId}/approve`, { hash: pv2.body.hash })).status, 200);
  // editing after approval sends it back to draft
  const e = await marketing.patch(`/marketing/${campId}`, { content: { ...pv2.body.preview, text: 'New text', channels: ['instagram'] } });
  assert.equal(e.body.status, 'draft'); assert.equal(e.body.approval_hash, null);
  await marketing.post(`/marketing/${campId}/submit`);
  const pv3 = await owner.get(`/marketing/${campId}/preview`);
  await owner.post(`/marketing/${campId}/approve`, { hash: pv3.body.hash });
  const s = await admin.post(`/marketing/${campId}/start`);
  assert.equal(s.status, 200);
  await drainJobs();
  const done = (await owner.get(`/marketing/${campId}`)).body;
  assert.equal(done.status, 'completed'); assert.match(done.result.mode, /sandbox/);   // test env never publishes for real
  const log = (await owner.get('/agents/actions?agent=arev')).body;
  assert.ok(log.some(a => a.action === 'campaign_approved')); assert.ok(log.some(a => a.action === 'publish' && a.approval_status === 'approved'));
});

test('SMS campaign: skips DNC, opted-out and no-consent people, respects hours, Pause/Stop, never double-sends', async () => {
  const mk = async (name, phone, extra) => { const r = await sales.post('/contacts', { name, phone, status: 'Qualified', timezone: 'America/Los_Angeles', ...extra }); return r.body.contact; };
  const a = await mk('Yes A', '(626) 555-0301', { sms_marketing: 'opted_in' });
  await mk('Yes B', '(626) 555-0302', { sms_marketing: 'opted_in' });
  await mk('No consent', '(626) 555-0303', {});
  await mk('Do not call', '(626) 555-0304', { sms_marketing: 'opted_in', dnc: true });
  const out = await mk('Opted out', '(626) 555-0305', { sms_marketing: 'opted_in' });
  await withBiz(biz.id, c => c.query(`update contacts set opted_out_at = now() where id = $1`, [out.id]));
  const c = await marketing.post('/marketing', { kind: 'sms_blast', title: 'Fall promo', content: { text: 'New fall colors for team polos. Reply STOP to opt out.', audience: { statuses: ['Qualified'] } } });
  await marketing.post(`/marketing/${c.body.id}/submit`);
  const pv = await owner.get(`/marketing/${c.body.id}/preview`);
  assert.equal(pv.body.preview.audienceSummary.eligible, 2);
  assert.ok(Object.keys(pv.body.preview.audienceSummary.skipped).some(k => /consent/.test(k)));
  await owner.post(`/marketing/${c.body.id}/approve`, { hash: pv.body.hash });
  // pretend it's a Tuesday 11:00 in LA so the hour check passes deterministically
  await withBiz(biz.id, cl => cl.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"00:00","end":"23:59","timezone":"America/Los_Angeles","days":[1,2,3,4,5,6,7]}') where id = $1`, [biz.id]));
  await withBiz(biz.id, cl => cl.query(`update contacts set timezone = 'America/Los_Angeles' where name in ('Yes A','Yes B','No consent','Do not call','Opted out')`));
  assert.equal((await owner.post(`/marketing/${c.body.id}/start`)).status, 200);
  await drainJobs(3);
  const d = (await owner.get(`/marketing/${c.body.id}`)).body;
  const by = Object.fromEntries(d.recipients.map(r => [r.name, r]));
  assert.equal(by['Yes A'].status, 'sent'); assert.equal(by['Yes B'].status, 'sent');
  assert.equal(by['No consent'].status, 'skipped'); assert.match(by['No consent'].skip_reason, /consent/);
  assert.equal(by['Do not call'].status, 'skipped'); assert.match(by['Do not call'].skip_reason, /Do Not Call/);
  assert.equal(by['Opted out'].status, 'skipped');
  assert.equal(sent.filter(m => /fall colors/.test(m.body)).length, 2);
  // running the campaign again cannot message anyone twice
  await withBiz(biz.id, cl => cl.query(`update campaign_recipients set status = 'pending' where campaign_id = $1 and contact_id = $2`, [c.body.id, a.id]));
  await withBiz(biz.id, cl => cl.query(`update campaigns set status = 'running' where id = $1`, [c.body.id]));
  await withBiz(biz.id, cl => cl.query(`insert into jobs (business_id, kind, payload) values ($1,'campaign.tick',$2)`, [biz.id, { campaignId: c.body.id }]));
  await drainJobs(3);
  assert.equal(sent.filter(m => /fall colors/.test(m.body)).length, 2);
  assert.equal((await owner.get(`/marketing/${c.body.id}`)).body.status, 'completed');
  assert.equal((await owner.post(`/marketing/${c.body.id}/stop`)).status, 409); // finished campaigns can't be stopped
});

test('outside campaign hours nothing is sent and the run waits for the next window', async () => {
  await withBiz(biz.id, cl => cl.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"09:00","end":"09:01","timezone":"Pacific/Kiritimati","days":[1]}') where id = $1`, [biz.id]));
  await sales.post('/contacts', { name: 'Hours Test', phone: '(626) 555-0399', status: 'Waiting', sms_marketing: 'opted_in' });
  const c = await marketing.post('/marketing', { kind: 'sms_blast', title: 'Hours', content: { text: 'hello Reply STOP to opt out', audience: { statuses: ['Waiting'] } } });
  await marketing.post(`/marketing/${c.body.id}/submit`);
  await owner.post(`/marketing/${c.body.id}/approve`, { hash: (await owner.get(`/marketing/${c.body.id}/preview`)).body.hash });
  await owner.post(`/marketing/${c.body.id}/start`);
  await drainJobs(2);
  assert.equal(sent.length, 0);
  const j = (await withBiz(biz.id, cl => cl.query(`select run_at from jobs where kind = 'campaign.tick' and payload->>'campaignId' = $1 and status = 'pending'`, [c.body.id]))).rows[0];
  assert.ok(new Date(j.run_at) > new Date(Date.now() + 60_000));
  await owner.post(`/marketing/${c.body.id}/pause`);
  assert.equal((await owner.get(`/marketing/${c.body.id}`)).body.status, 'paused');
  assert.equal((await marketing.post(`/marketing/${c.body.id}/stop`)).status, 403);
  await owner.post(`/marketing/${c.body.id}/stop`);
  const st = (await owner.get(`/marketing/${c.body.id}`)).body;
  assert.equal(st.status, 'stopped'); assert.equal(st.recipients[0].skip_reason, 'Campaign stopped');
  assert.equal((await owner.post(`/marketing/${c.body.id}/start`)).status, 409);
});

test('call campaigns need Natalie outbound calls on and written consent', async () => {
  const c = await marketing.post('/marketing', { kind: 'call_campaign', title: 'Calls', content: { text: 'brief', audience: { statuses: ['Qualified'] } } });
  await marketing.post(`/marketing/${c.body.id}/submit`);
  const pv = await owner.get(`/marketing/${c.body.id}/preview`);
  assert.ok(pv.body.warnings.some(w => /written call consent/.test(w)));
  assert.ok(Object.keys(pv.body.preview.audienceSummary.skipped).some(k => /written consent/.test(k)));
  await owner.post(`/marketing/${c.body.id}/approve`, { hash: pv.body.hash });
  const s = await owner.post(`/marketing/${c.body.id}/start`);
  assert.equal(s.status, 409); assert.match(s.body.error, /outbound calls are turned off/);
});

test('regression: stopping a campaign also stops texts already queued', async () => {
  await withBiz(biz.id, cl => cl.query(`update businesses set settings = jsonb_set(settings, '{campaignHours}', '{"start":"00:00","end":"23:59","timezone":"America/Los_Angeles","days":[1,2,3,4,5,6,7]}') where id = $1`, [biz.id]));
  await sales.post('/contacts', { name: 'Queued One', phone: '(626) 555-0401', status: 'Won', sms_marketing: 'opted_in', timezone: 'America/Los_Angeles' });
  const c = await marketing.post('/marketing', { kind: 'sms_blast', title: 'Stop me', content: { text: 'Promo. Reply STOP to opt out.', audience: { statuses: ['Won'] } } });
  await marketing.post(`/marketing/${c.body.id}/submit`);
  await owner.post(`/marketing/${c.body.id}/approve`, { hash: (await owner.get(`/marketing/${c.body.id}/preview`)).body.hash });
  await owner.post(`/marketing/${c.body.id}/start`);
  // run only the campaign step so the text is queued but not yet delivered
  await withBiz(biz.id, cl => cl.query(`update jobs set run_at = now() + interval '1 hour' where kind = 'message.send' and status = 'pending'`));
  const { runDueJobs } = await import('./helpers.js');
  await runDueJobs({ limit: 50 });
  assert.equal((await withBiz(biz.id, cl => cl.query(`select count(*)::int n from messages where idempotency_key like $1 and status = 'queued'`, [`camp:${c.body.id}:%`]))).rows[0].n, 1);
  await owner.post(`/marketing/${c.body.id}/stop`);
  await drainJobs();
  assert.equal(sent.filter(m => /Promo/.test(m.body)).length, 0);
  const m = (await withBiz(biz.id, cl => cl.query(`select status, status_detail from messages where idempotency_key like $1`, [`camp:${c.body.id}:%`]))).rows[0];
  assert.equal(m.status, 'blocked'); assert.match(m.status_detail, /stopped/);
});

test('regression: approval covers WhatsApp template variables', async () => {
  const c = await marketing.post('/marketing', { kind: 'whatsapp_blast', title: 'WA', content: { text: 'x', template_sid: 'HX1', template_variables: { 1: 'Fall' }, audience: { statuses: ['Won'] } } });
  const a = (await owner.get(`/marketing/${c.body.id}/preview`)).body;
  assert.deepEqual(a.preview.templateVariables, { 1: 'Fall' });
  await withBiz(biz.id, cl => cl.query(`update campaigns set content = jsonb_set(content, '{template_variables}', '{"1":"Other"}') where id = $1`, [c.body.id]));
  assert.notEqual((await owner.get(`/marketing/${c.body.id}/preview`)).body.hash, a.hash);
});

test('Arev kill switch', async () => {
  await owner.patch('/agents/arev', { enabled: false });
  fakeLLM(() => text('x'));
  const r = await marketing.post('/marketing/arev', { kind: 'social_post', brief: 'x' });
  assert.equal(r.status, 409);
  await owner.patch('/agents/arev', { enabled: true });
});

// ---------------- quotes & orders ----------------
let contactId, quoteId;
test('price list: only owner/admin can set prices', async () => {
  assert.equal((await sales.post('/price-list', { sku: 'POLO-EMB', name: 'Polo', product_type: 'Polos', decoration: 'Embroidery', min_qty: 20, unit_price: 22 })).status, 403);
  await owner.post('/price-list', { sku: 'POLO-EMB', name: 'Polo, left-chest embroidery', product_type: 'Polos', decoration: 'Embroidery', min_qty: 20, unit_price: 22 });
  await owner.post('/price-list', { sku: 'POLO-EMB', name: 'Polo, left-chest embroidery', product_type: 'Polos', decoration: 'Embroidery', min_qty: 50, unit_price: 19.5 });
  await owner.post('/price-list', { sku: 'HAT-X', name: 'Unapproved hat', product_type: 'Hats', decoration: 'Embroidery', min_qty: 20, unit_price: 9, approve: false });
});

test('AI quote draft uses the approved price tier only and needs approval', async () => {
  const c = await sales.post('/contacts', { name: 'Daniel Kim', company: 'Seoul Kitchen', phone: '(213) 555-0402', product_type: 'Polos', quantity: 60, decoration: 'Embroidery', colors: 'Black' });
  contactId = c.body.contact.id;
  const q = await sales.post('/quotes/ai-draft', { contactId });
  assert.equal(q.status, 201); assert.equal(q.body.created_by_agent, 'natalie');
  quoteId = q.body.id;
  const full = (await sales.get(`/quotes/${quoteId}`)).body;
  assert.equal(full.items[0].unit_price, 19.5); assert.equal(full.items[0].qty, 60);
  assert.equal(full.subtotal, 1170); assert.equal(full.tax, Math.round(1170 * 0.095 * 100) / 100);
  const hat = await sales.post('/contacts', { name: 'Hat Guy', phone: '(213) 555-0403', product_type: 'Hats', quantity: 30, decoration: 'Embroidery' });
  const h = await sales.post('/quotes/ai-draft', { contactId: hat.body.contact.id });
  assert.equal(h.status, 400); assert.match(h.body.error, /No approved price/);
  const miss = await sales.post('/contacts', { name: 'Vague', phone: '(213) 555-0404' });
  assert.match((await sales.post('/quotes/ai-draft', { contactId: miss.body.contact.id })).body.error, /missing/);
});

test('sales cannot approve final prices; owner can; approved quotes are locked', async () => {
  assert.equal((await sales.post(`/quotes/${quoteId}/submit`)).status, 200);
  const s = await sales.post(`/quotes/${quoteId}/approve`);
  assert.equal(s.status, 403);
  assert.equal((await sales.post(`/quotes/${quoteId}/mark_sent`)).status, 409);
  assert.equal((await owner.post(`/quotes/${quoteId}/approve`)).body.status, 'approved');
  assert.equal((await sales.patch(`/quotes/${quoteId}`, { shipping: 10 })).status, 409);
  assert.equal((await sales.post(`/quotes/${quoteId}/mark_sent`)).body.status, 'sent');
  assert.equal((await sales.get(`/contacts/${contactId}`)).body.contact.status, 'Quote Sent');
  const print = await sales.raw('GET', `/quotes/${quoteId}/print`);
  assert.match(print.body, /Quote Q-1/); assert.doesNotMatch(print.body, /DRAFT — NOT APPROVED/);
});

test('approved quote becomes an order with no re-typing; repeated clicks create one order', async () => {
  const o1 = await sales.post(`/quotes/${quoteId}/order`);
  const o2 = await sales.post(`/quotes/${quoteId}/order`);
  assert.equal(o1.status, 201); assert.equal(o2.status, 200); assert.equal(o1.body.order.id, o2.body.order.id);
  const o = (await sales.get(`/orders/${o1.body.order.id}`)).body;
  assert.equal(o.items[0].qty, 60); assert.equal(o.items[0].unit_price, 19.5); assert.equal(o.total, (await sales.get(`/quotes/${quoteId}`)).body.total);
  assert.equal(o.status, 'New'); assert.equal(o.quote_no, 1);
  assert.equal((await sales.get(`/contacts/${contactId}`)).body.contact.status, 'Won');
  // design version + recorded customer approval + production guard
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'mockup-v1.pdf');
  assert.equal((await sales.post(`/orders/${o.id}/designs`, fd)).status, 201);
  const blocked = await sales.patch(`/orders/${o.id}`, { status: 'In Production' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'design_not_approved');
  const d = (await sales.get(`/orders/${o.id}`)).body.designs[0];
  assert.equal((await sales.post(`/orders/${o.id}/designs/${d.id}/approve`, { note: 'SMS reply: looks great' })).status, 200);
  const after = (await sales.get(`/orders/${o.id}`)).body;
  assert.equal(after.status, 'Awaiting Payment');
  await sales.patch(`/orders/${o.id}`, { payment_status: 'paid', amount_paid: after.total });
  assert.equal((await sales.patch(`/orders/${o.id}`, { status: 'In Production' })).body.status, 'In Production');
  assert.equal((await viewer.patch(`/orders/${o.id}`, { status: 'Ready' })).status, 403);
  const tl = (await sales.get(`/contacts/${contactId}`)).body.timeline.map(t => t.summary).join('\n');
  assert.match(tl, /Order #1 created from quote Q-1/); assert.match(tl, /approved design v1/);
});
