import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeBusiness, startServer, stopServer, login, connectChannel, drainJobs, withBiz, publicFetch } from './helpers.js';

let biz, owner, sales, marketing, sentMail;
before(async () => {
  await resetDb();
  biz = await makeBusiness();
  await connectChannel(biz, 'email', { address: 'dssystemsusa@gmail.com', fromName: 'DS Systems' }, { password: 'app-password' });
  await startServer();
  owner = await login('owner@ds-systems.test'); sales = await login('sales@ds-systems.test'); marketing = await login('marketing@ds-systems.test');
});
after(stopServer);
beforeEach(async () => {
  sentMail = [];
  const { setMailer } = await import('../src/integrations/email.js');
  setMailer({ verify: async () => true, close() {}, sendMail: async opts => { sentMail.push(opts); return { messageId: `<m${sentMail.length}-${Date.now()}@gmail.com>`, rejected: [] }; } });
});

test('email from the customer card: subject required, sent from the mailbox, threaded, logged on the timeline', async () => {
  const ct = (await sales.post('/contacts', { name: 'Lena Mail', company: 'Mail Roofing', phone: '(818) 555-0601', email: 'lena@mailroofing.com' })).body.contact;
  const cv = (await sales.post('/inbox/start', { contactId: ct.id, channel: 'email' })).body;
  assert.equal(cv.channel, 'email'); assert.equal(cv.external_thread_id, 'lena@mailroofing.com');
  const fd0 = new FormData(); fd0.append('body', 'Hello');
  assert.equal((await sales.post(`/inbox/${cv.id}/reply`, fd0)).status, 400, 'a first email needs a subject');
  const fd = new FormData(); fd.append('body', 'Hi Lena, do your crews need branded work shirts?'); fd.append('subject', 'Work shirts for Mail Roofing');
  const r = await sales.post(`/inbox/${cv.id}/reply`, fd);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await drainJobs();
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'lena@mailroofing.com'); assert.equal(sentMail[0].subject, 'Work shirts for Mail Roofing');
  assert.deepEqual(sentMail[0].from, { name: 'DS Systems', address: 'dssystemsusa@gmail.com' });
  assert.ok(!/Unsubscribe/.test(sentMail[0].text), 'a personal email carries no unsubscribe line');
  assert.ok(/DS Systems LLC/.test(sentMail[0].text), 'signature added');
  const th = (await sales.get(`/inbox/${cv.id}`)).body;
  assert.equal(th.messages[0].status, 'sent'); assert.match(th.messages[0].provider_message_id, /^<m1-/);
  // a second email in the same thread is a reply (Re:) referencing the first
  const fd2 = new FormData(); fd2.append('body', 'Following up.');
  await sales.post(`/inbox/${cv.id}/reply`, fd2); await drainJobs();
  assert.equal(sentMail[1].subject, 'Re: Work shirts for Mail Roofing'); assert.equal(sentMail[1].inReplyTo, th.messages[0].provider_message_id);
  const card = (await sales.get(`/contacts/${ct.id}`)).body;
  assert.ok(card.timeline.some(t => /^Email queued by Staff/.test(t.summary)));
});

test('replies pulled from the mailbox land in the Inbox on the right customer; "unsubscribe" in a reply stops marketing email', async () => {
  const { pollMailbox } = await import('../src/integrations/email.js');
  const lena = (await sales.get('/contacts?q=Lena')).body.rows[0];
  const raw = (from, subject, body, id, extra = '') => Buffer.from(`From: ${from}\r\nTo: dssystemsusa@gmail.com\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: Mon, 19 Oct 2026 10:00:00 -0700\r\n${extra}\r\n${body}\r\n`);
  const mails = [
    { uid: 11, source: raw('Lena <lena@mailroofing.com>', 'Re: Work shirts for Mail Roofing', 'Yes, send me samples for 30 guys.\r\n\r\nOn Mon Oct 19 DS Systems wrote:\r\n> Hi Lena', '<r1@mailroofing.com>') },
    { uid: 12, source: raw('New Person <new@someco.com>', 'Quote?', 'Do you make aprons?', '<r2@someco.com>') },
    { uid: 13, source: raw('noreply@shop.com', 'Your receipt', 'Thanks for your order', '<r3@shop.com>') },
    { uid: 14, source: raw('Lena <lena@mailroofing.com>', 'Re: Work shirts', 'Please unsubscribe me', '<r4@mailroofing.com>') },
  ];
  const fakeClient = (uidNext, list) => ({
    mailbox: { uidValidity: 7, uidNext }, connect: async () => {}, logout: async () => {},
    getMailboxLock: async () => ({ release() {} }),
    fetch: async function* (range) { for (const m of list) yield { uid: m.uid, source: m.source }; },
  });
  // first poll: only sets the cursor (never imports years of old mail)
  assert.deepEqual(await pollMailbox(biz.id, { client: fakeClient(11, []) }), { imported: 0 });
  const r = await pollMailbox(biz.id, { client: fakeClient(15, mails) });
  assert.equal(r.imported, 3, 'noreply skipped');
  const inbox = (await sales.get('/inbox')).body.rows;
  const lenaThread = inbox.find(x => x.contact_id === lena.id && x.channel === 'email');
  assert.ok(lenaThread && lenaThread.needs_reply);
  const th = (await sales.get(`/inbox/${lenaThread.id}`)).body;
  const inMsgs = th.messages.filter(m => m.direction === 'in');
  assert.equal(inMsgs[0].body, 'Re: Work shirts for Mail Roofing\n\nYes, send me samples for 30 guys.', 'quoted history stripped');
  assert.equal(th.conversation.ai_enabled, false);
  const newLead = (await sales.get('/contacts?q=someco')).body.rows[0];
  assert.ok(newLead && newLead.email === 'new@someco.com' && newLead.source === 'email');
  const lenaNow = (await sales.get(`/contacts/${lena.id}`)).body.contact;
  assert.ok(lenaNow.email_opted_out_at, 'unsubscribe request honoured');
  // the same mail is never imported twice
  assert.equal((await pollMailbox(biz.id, { client: fakeClient(15, mails) })).imported, 0);
});

test('email campaign: Arev draft with subject, owner approval, paced sending with unsubscribe link, unsubscribed and no-email people skipped, daily limit', async () => {
  const { fakeLLM } = await import('./helpers.js');
  fakeLLM(() => ({ content: [{ type: 'text', text: 'Subject: Uniforms for {company}\n\nHi {first_name}, we make work shirts with your logo for framing crews. Reply to this email or text UNIFORM to (747) 588-7117.' }] }));
  const mk = (name, email, extra = {}) => sales.post('/contacts', { name, company: `${name} Co`, phone: null, email, status: 'New', source: 'CSLB', ...extra }).then(r => r.body.contact);
  const a = await mk('Ann Email', 'ann@a.com'); const b = await mk('Ben Email', 'ben@b.com'); await mk('Cid Nomail', null); const lena = (await sales.get('/contacts?q=Lena')).body.rows[0];
  const d = await marketing.post('/marketing/arev', { kind: 'email_blast', brief: 'framing crews', audience: { sources: ['CSLB', 'manual'] } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const camp = d.body;
  assert.equal(camp.content.subject, 'Uniforms for {company}');
  assert.ok(!/Subject:/.test(camp.content.text));
  await marketing.post(`/marketing/${camp.id}/submit`);
  const pv = await owner.get(`/marketing/${camp.id}/preview`);
  assert.equal(pv.body.preview.subject, 'Uniforms for {company}');
  assert.equal(pv.body.preview.audienceSummary.eligible, 2, JSON.stringify(pv.body.preview.audienceSummary));
  assert.equal(pv.body.preview.audienceSummary.skipped['No email address'], 1);
  assert.equal((await sales.post(`/marketing/${camp.id}/approve`, { hash: pv.body.hash })).status, 403, 'only the owner approves');
  await owner.post(`/marketing/${camp.id}/approve`, { hash: pv.body.hash });
  assert.equal((await owner.post(`/marketing/${camp.id}/start`)).status, 200);
  await drainJobs(6);
  const done = (await owner.get(`/marketing/${camp.id}`)).body;
  const by = Object.fromEntries(done.recipients.map(r => [r.name, r]));
  assert.equal(by['Ann Email'].status, 'sent'); assert.equal(by['Ben Email'].status, 'sent');
  assert.equal(by['Cid Nomail'].status, 'skipped');
  const ann = sentMail.find(m => m.to === 'ann@a.com');
  assert.equal(ann.subject, 'Uniforms for Ann Email Co');
  assert.match(ann.text, /^Hi Ann, we make work shirts/);
  assert.match(ann.text, /Unsubscribe: http:\/\/crm\.test\/api\/public\/unsubscribe\//);
  assert.ok(ann.list?.unsubscribe?.url && ann.headers['List-Unsubscribe-Post']);
  // one-click unsubscribe link works without login; a bad signature does nothing
  const link = /Unsubscribe: (\S+)/.exec(ann.text)[1].replace('http://crm.test', '');
  const bad = await publicFetch(link.replace(/[^/]+$/, 'forged'));
  assert.match(await bad.text(), /not valid/);
  const ok = await publicFetch(link);
  assert.match(await ok.text(), /unsubscribed/);
  assert.ok((await sales.get(`/contacts/${a.id}`)).body.contact.email_opted_out_at);
  // the Email button is disabled and a new campaign skips her
  const again = await marketing.post('/marketing', { kind: 'email_blast', title: 'again', content: { subject: 'S', text: 'T', audience: { contactIds: [a.id, b.id] } } });
  await marketing.post(`/marketing/${again.body.id}/submit`);
  const pv2 = (await owner.get(`/marketing/${again.body.id}/preview`)).body;
  assert.equal(pv2.preview.audienceSummary.skipped['Unsubscribed from email'], 1);
  // daily limit: 1 → the second recipient waits
  await owner.patch('/settings', { email: { dailyLimit: 1 } });
  const c3 = await marketing.post('/marketing', { kind: 'email_blast', title: 'limit', content: { subject: 'S', text: 'T', audience: { contactIds: [b.id, lena.id] } } });
  await marketing.post(`/marketing/${c3.body.id}/submit`);
  const pv3 = (await owner.get(`/marketing/${c3.body.id}/preview`)).body;
  await owner.post(`/marketing/${c3.body.id}/approve`, { hash: pv3.hash });
  const before = sentMail.length;
  await owner.post(`/marketing/${c3.body.id}/start`); await drainJobs(4);
  assert.equal(sentMail.length, before, 'already over today\'s limit: nothing more goes out today');
  assert.equal((await owner.get(`/marketing/${c3.body.id}`)).body.status, 'running');
});

test('saving the mailbox starts polling; a dead poll job is revived on start', async () => {
  const r = await owner.put('/settings/channels/email', { config: { address: 'dssystemsusa@gmail.com' }, secrets: { password: 'app-password' } });
  assert.equal(r.body.status, 'connected');
  const job = () => withBiz(biz.id, c => c.query(`select status from jobs where idempotency_key = 'email.poll'`)).then(x => x.rows[0]);
  assert.equal((await job()).status, 'pending');
  await withBiz(biz.id, c => c.query(`update jobs set status = 'dead' where idempotency_key = 'email.poll'`));
  const { ensureEmailPolling } = await import('../src/integrations/email.js');
  await ensureEmailPolling();
  assert.equal((await job()).status, 'pending');
});
