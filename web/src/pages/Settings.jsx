import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, post, put, del, api, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, Field, useAction, Switch, Confirm, Empty } from '../components/ui.jsx';
import { useSession, applyPrefs } from '../lib/session.jsx';
import { dateTime, phone } from '../lib/format.js';

const TABS = [['general', 'Business rules', 'settings.read'], ['channels', 'Channels', 'settings.read'], ['website', 'Website', 'settings.read'], ['team', 'Team & roles', 'users.manage'],
  ['fields', 'Custom fields', 'settings.write'], ['look', 'My account', null], ['replies', 'Saved replies', 'settings.write'], ['dnc', 'Do Not Call', 'contacts.read'],
  ['failed', 'Failed actions', 'jobs.manage'], ['audit', 'Activity history', 'audit.read'], ['data', 'Backups & data', 'backup.manage']];

export default function Settings() {
  const { tab = 'general' } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const tabs = TABS.filter(t => !t[2] || can(t[2]));
  const T = { general: General, channels: Channels, website: Website, team: Team, fields: Fields, look: Look, replies: Replies, dnc: Dnc, failed: Failed, audit: Audit, data: Data }[tab] || General;
  return (
    <>
      <div className="page-head"><h1>Settings</h1></div>
      <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => nav(`/settings/${k}`)}>{l}</button>)}</div>
      <T />
    </>
  );
}

function General() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => get('/settings'), []);
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (data) setF(structuredClone(data.settings)); }, [data]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!f) return <div className="empty">Loading…</div>;
  const w = can('settings.write');
  const save = () => run(() => patch('/settings', { links: { quotePage: f.links.quotePage, contactPage: f.links.contactPage }, moq: { minQty: Number(f.moq.minQty) },
    campaignHours: { start: f.campaignHours.start, end: f.campaignHours.end, timezone: f.campaignHours.timezone, days: f.campaignHours.days },
    calls: { recordCalls: f.calls.recordCalls, recordingDisclosure: f.calls.recordingDisclosure, handoffNumber: f.calls.handoffNumber, ringTimeoutSec: Number(f.calls.ringTimeoutSec), postCallSms: f.calls.postCallSms || { enabled: false, text: '' } },
    quotes: { defaultTaxRate: Number(f.quotes.defaultTaxRate), validDays: Number(f.quotes.validDays) } }), 'Settings saved').then(reload);
  const check = data.settings.links.checks || {};
  const linkState = url => { const c = check[url]; if (!c) return <Pill>Not checked yet</Pill>; return c.ok ? <Pill tone="green">Works ({c.status})</Pill> : <Pill tone="red">Not working: {c.status || c.error}</Pill>; };
  const set = (path, v) => { const n = structuredClone(f); const ks = path.split('.'); let o = n; for (const k of ks.slice(0, -1)) o = o[k] ||= {}; o[ks.at(-1)] = v; setF(n); };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="panel"><h2>Quote links Natalie shares</h2>
        <p className="muted" style={{ marginTop: -6 }}>Natalie never gives prices — she sends people to these pages instead.</p>
        <div className="grid2">
          <Field label="Quote request page">{<input className="in" disabled={!w} value={f.links.quotePage} onChange={e => set('links.quotePage', e.target.value)} />}</Field>
          <Field label="Contact page"><input className="in" disabled={!w} value={f.links.contactPage} onChange={e => set('links.contactPage', e.target.value)} /></Field>
        </div>
        <div className="row" style={{ marginTop: 8 }}>{linkState(data.settings.links.quotePage)} {linkState(data.settings.links.contactPage)}
          {w && <button className="btn small" disabled={busy} onClick={() => run(() => post('/settings/links/check'), 'Links checked').then(reload)}>Check links now</button>}</div>
      </section>
      <section className="panel"><h2>Orders</h2>
        <div className="grid2">
          <Field label="Minimum order (pieces of the same item and color)"><input className="in" type="number" min="1" disabled={!w} value={f.moq.minQty} onChange={e => set('moq.minQty', e.target.value)} /></Field>
          <Field label="Default sales tax (%)"><input className="in" type="number" step="0.01" disabled={!w} value={(f.quotes.defaultTaxRate * 100).toFixed(2)} onChange={e => set('quotes.defaultTaxRate', Number(e.target.value) / 100)} /></Field>
          <Field label="Quotes valid for (days)"><input className="in" type="number" disabled={!w} value={f.quotes.validDays} onChange={e => set('quotes.validDays', e.target.value)} /></Field>
        </div>
      </section>
      <section className="panel"><h2>Campaign hours</h2>
        <p className="muted" style={{ marginTop: -6 }}>Marketing texts and calls only go out inside these hours, and inside the customer's own local hours.</p>
        <div className="grid2">
          <Field label="From"><input className="in" type="time" disabled={!w} value={f.campaignHours.start} onChange={e => set('campaignHours.start', e.target.value)} /></Field>
          <Field label="Until"><input className="in" type="time" disabled={!w} value={f.campaignHours.end} onChange={e => set('campaignHours.end', e.target.value)} /></Field>
          <Field label="Time zone"><select className="in" disabled={!w} value={f.campaignHours.timezone} onChange={e => set('campaignHours.timezone', e.target.value)}>{['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York'].map(z => <option key={z}>{z}</option>)}</select></Field>
        </div>
        <div className="row" style={{ marginTop: 8 }}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => <label key={d} className="row"><input type="checkbox" disabled={!w} checked={f.campaignHours.days.includes(i + 1)} onChange={e => set('campaignHours.days', e.target.checked ? [...f.campaignHours.days, i + 1].sort() : f.campaignHours.days.filter(x => x !== i + 1))} />{d}</label>)}</div>
      </section>
      <section className="panel"><h2>Calls</h2>
        <div className="grid2">
          <Field label="Transfer calls to this phone" hint="Used when Natalie hands off or nobody answers in the app."><input className="in" type="tel" disabled={!w} value={f.calls.handoffNumber ? phone(f.calls.handoffNumber) : ''} onChange={e => set('calls.handoffNumber', e.target.value)} /></Field>
          <Field label="Ring for (seconds)"><input className="in" type="number" disabled={!w} value={f.calls.ringTimeoutSec} onChange={e => set('calls.ringTimeoutSec', e.target.value)} /></Field>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <Switch disabled={!w} checked={f.calls.recordCalls} onChange={v => set('calls.recordCalls', v)} label="Record calls" />
          {f.calls.recordCalls && <><div className="notice warn small">California requires telling everyone on the call. The sentence below is played at the start of every recorded call.</div>
            <Field label="Recording announcement"><input className="in" disabled={!w} value={f.calls.recordingDisclosure} onChange={e => set('calls.recordingDisclosure', e.target.value)} /></Field></>}
          <Switch disabled={!w} checked={f.calls.postCallSms?.enabled} onChange={v => set('calls.postCallSms', { ...(f.calls.postCallSms || { text: 'Thanks for calling DS Systems! Request your written quote here: {quoteLink}' }), enabled: v })} label="Send a text after each answered call" />
          {f.calls.postCallSms?.enabled && <Field label="Text" hint="{name} and {quoteLink} are filled in. Only sent if the customer may be texted; you will see if it fails."><textarea className="in" disabled={!w} value={f.calls.postCallSms.text} onChange={e => set('calls.postCallSms', { ...f.calls.postCallSms, text: e.target.value })} /></Field>}
        </div>
      </section>
      {w && <div className="row"><button className="btn primary" disabled={busy} onClick={save}>Save settings</button><button className="btn" onClick={() => setF(structuredClone(data.settings))}>Undo changes</button></div>}
    </div>
  );
}

const CH_HELP = {
  sms: 'Twilio Console → Account → API keys & tokens. Use the phone number you bought in Twilio.',
  voice: 'Same Twilio account. For the browser phone also create an API key and a TwiML App whose voice URL is shown below.',
  whatsapp: 'Your WhatsApp Business number registered through Twilio (WhatsApp senders).',
  messenger: 'Meta for Developers app with Messenger: Page ID and a Page access token, the app secret, and a verify token you choose.',
  instagram: 'Same Meta app with Instagram messaging: Instagram business account ID, the linked Page access token, app secret and verify token.',
  shopify: 'Optional. Shopify admin → Apps → Develop apps → Admin API access token.',
  webchat: 'Turns on automatically the first time a visitor writes from your website.',
  website_forms: 'Turns on automatically when the first quote form arrives from your website.',
  ai: 'Set ANTHROPIC_API_KEY on the server (not here) and restart, then check the connection.',
};
const NICE = { accountSid: 'Account SID', authToken: 'Auth token', apiKeySid: 'API key SID', apiKeySecret: 'API key secret', phoneNumber: 'Phone number', messagingServiceSid: 'Messaging Service SID (optional)', twimlAppSid: 'TwiML App SID', whatsappNumber: 'WhatsApp number', pageAccessToken: 'Page access token', appSecret: 'App secret', verifyToken: 'Verify token', pageId: 'Facebook Page ID', igAccountId: 'Instagram account ID', adminToken: 'Admin API token', webhookSecret: 'Webhook secret', shopDomain: 'Store domain (xxx.myshopify.com)' };

function Channels() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => get('/settings/channels'), []);
  const info = useLoad(() => get('/calls/setup-info'), []);
  const [edit, setEdit] = useState(null);
  const [run, busy] = useAction();
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <div className="empty">Loading…</div>;
  const tone = { connected: 'green', needs_setup: '', error: 'red' }; const label = { connected: 'Connected', needs_setup: 'Needs setup', error: 'Error' };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>A channel shows "Connected" only after the provider confirms the credentials work or a real message has arrived.</p>
      {data.map(ch => (
        <section key={ch.channel} className="panel">
          <div className="row"><h2 style={{ margin: 0 }}>{ch.label}</h2><Pill tone={tone[ch.status]}>{label[ch.status]}</Pill><span className="spacer" />
            {ch.lastCheckedAt && <span className="small muted">Checked {dateTime(ch.lastCheckedAt)}</span>}
            {can('integrations.write') && ch.fields.secrets.length + ch.fields.config.length > 0 && <button className="btn small" onClick={() => setEdit(edit === ch.channel ? null : ch.channel)}>{edit === ch.channel ? 'Close' : ch.status === 'needs_setup' ? 'Set up' : 'Edit'}</button>}
            {can('integrations.write') && ['sms', 'voice', 'whatsapp', 'messenger', 'instagram', 'ai', 'shopify'].includes(ch.channel) && ch.status !== 'needs_setup' && <button className="btn small" disabled={busy} onClick={() => run(() => post(`/settings/channels/${ch.channel}/verify`), r => (r.status === 'connected' ? 'Connection works' : 'Connection check failed — see the error')).then(reload)}>Check connection</button>}</div>
          {ch.lastError && <div className={`notice ${ch.status === 'error' ? 'bad' : ''} small`} style={{ marginTop: 8 }}>{ch.lastError}</div>}
          <p className="small muted" style={{ margin: '8px 0 0' }}>{CH_HELP[ch.channel]}</p>
          {edit === ch.channel && <ChannelForm ch={ch} onDone={() => { setEdit(null); reload(); }} />}
        </section>
      ))}
      {info.data && <section className="panel"><h2>Addresses to paste into Twilio and Meta</h2>
        <dl className="kv" style={{ gridTemplateColumns: '240px 1fr' }}>
          <dt>Twilio number: "A call comes in"</dt><dd><code>{info.data.numberVoiceUrl}</code></dd>
          <dt>Twilio number: call status changes</dt><dd><code>{info.data.numberStatusUrl}</code></dd>
          <dt>Twilio number / WhatsApp: "A message comes in"</dt><dd><code>{info.data.messagingUrl}</code></dd>
          <dt>TwiML App voice URL (browser phone)</dt><dd><code>{info.data.twimlAppVoiceUrl}</code></dd>
          <dt>Meta webhook callback URL</dt><dd><code>{info.data.metaWebhookUrl}</code></dd></dl></section>}
    </div>
  );
}

function ChannelForm({ ch, onDone }) {
  const [cfg, setCfg] = useState({ ...ch.config });
  const [sec, setSec] = useState({});
  const [run, busy] = useAction();
  return (
    <form style={{ display: 'grid', gap: 10, marginTop: 12 }} onSubmit={e => { e.preventDefault(); run(() => put(`/settings/channels/${ch.channel}`, { config: cfg, secrets: sec }), r => (r.status === 'connected' ? 'Connected' : r.status === 'error' ? 'Saved, but the provider rejected it — see the error' : 'Saved — still missing details')).then(onDone); }}>
      <div className="grid2">
        {ch.fields.config.map(k => <Field key={k} label={NICE[k] || k}><input className="in" value={cfg[k] || ''} onChange={e => setCfg({ ...cfg, [k]: e.target.value })} /></Field>)}
        {ch.fields.secrets.map(k => <Field key={k} label={NICE[k] || k} hint={ch.secretsSet[k] ? 'Saved. Leave blank to keep it.' : 'Stored encrypted on the server.'}><input className="in" type="password" autoComplete="off" value={sec[k] || ''} onChange={e => setSec({ ...sec, [k]: e.target.value })} placeholder={ch.secretsSet[k] ? '••••••••' : ''} /></Field>)}
      </div>
      <div className="row"><button className="btn primary" disabled={busy}>Save and check</button></div>
    </form>
  );
}

function Website() {
  const { data } = useLoad(() => get('/settings'), []);
  if (!data) return <div className="empty">Loading…</div>;
  const key = data.business.public_key;
  const tag = `<script src="${data.publicUrl}/widget.js" data-key="${key}" defer></script>`;
  const form = `<div id="ds-quote"></div>\n<script src="${data.publicUrl}/widget.js" data-key="${key}" data-quote-form="#ds-quote" data-chat="off" defer></script>`;
  const hook = `${data.publicUrl}/api/public/${key}/shopify-quote`;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="panel"><h2>Your existing "Get a Quote" form</h2>
        <p>Your theme already sends a copy of each quote request to the address set as the form's <code>data-webhook</code>. Paste this address there (Shopify → Online Store → Themes → Customize → Get a Quote, or Edit code → the form with <code>data-dss-quote</code>):</p>
        <pre className="code">{hook}</pre>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(hook)}>Copy</button>
        <p className="small muted">Shopify keeps emailing you as before. In the CRM each request becomes a lead with products, print locations, budget and notes, plus a follow-up task.</p></section>
      <section className="panel"><h2>Website chat (Shopify)</h2>
        <p>Your site runs on Shopify. In Shopify admin open <b>Online Store → Themes → Edit code → theme.liquid</b> and paste this line just before <code>&lt;/body&gt;</code>:</p>
        <pre className="code">{tag}</pre>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(tag)}>Copy</button></section>
      <section className="panel"><h2>Optional: CRM quote form</h2>
        <p>On the page where customers request quotes, add a <b>Custom Liquid</b> section and paste:</p>
        <pre className="code">{form}</pre>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(form)}>Copy</button>
        <p className="small muted">Requests land in the Inbox and on the customer card, with a follow-up task. The form asks for SMS marketing consent separately (unchecked by default).</p></section>
      <section className="panel"><h2>Allowed website addresses</h2><p className="muted" style={{ marginTop: -6 }}>Set on the server (SITE_ORIGINS). Currently: {data.siteOrigins.join(', ')}</p></section>
    </div>
  );
}

function Team() {
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => get('/settings/users'), []);
  const [f, setF] = useState({ name: '', email: '', role: 'sales' });
  const [created, setCreated] = useState(null);
  const [run, busy] = useAction();
  const ROLE_HELP = { owner: 'Everything, including approvals, AI switches and backups', admin: 'Everything except approving marketing and AI switches', sales: 'Customers, inbox, calls, quotes and orders', marketing: 'Marketing drafts and reports', viewer: 'Can look, cannot change' };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <LoadError error={error} retry={reload} />
      <section className="panel"><h2>People</h2>
        <ul className="list">{(data || []).map(u => <li key={u.id} className="row" style={{ padding: '8px 0' }}>
          <span style={{ flex: 1 }}><b>{u.name}</b> <span className="muted">{u.email}</span>{!u.active && <> <Pill tone="red">Deactivated</Pill></>}</span>
          <select className="in" style={{ width: 'auto' }} value={u.role} disabled={u.id === me.user.id} onChange={e => run(() => patch(`/settings/users/${u.id}`, { role: e.target.value }), 'Role changed').then(reload)} aria-label={`Role for ${u.name}`}>{Object.keys(ROLE_HELP).map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select>
          {u.id !== me.user.id && <button className="btn small" onClick={() => run(() => patch(`/settings/users/${u.id}`, { active: !u.active }), u.active ? 'Deactivated and signed out' : 'Reactivated').then(reload)}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}
        </li>)}</ul></section>
      <section className="panel"><h2>Add a person</h2>
        <form className="grid2" onSubmit={e => { e.preventDefault(); run(() => post('/settings/users', f), 'Person added').then(r => { setCreated(r); setF({ name: '', email: '', role: 'sales' }); reload(); }); }}>
          <Field label="Name"><input className="in" required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><input className="in" type="email" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role" hint={ROLE_HELP[f.role]}><select className="in" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{Object.keys(ROLE_HELP).map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></Field>
          <div style={{ alignSelf: 'end' }}><button className="btn primary" disabled={busy}>Add person</button></div>
        </form>
        {created && <div className="notice good" style={{ marginTop: 10 }}>Temporary password: <b>{created.tempPassword}</b><div className="small">{created.note}</div></div>}</section>
    </div>
  );
}

function Fields() {
  const { data, reload } = useLoad(() => get('/settings/fields'), []);
  const [f, setF] = useState({ label: '', type: 'text', options: '' });
  const [run, busy] = useAction();
  return (
    <section className="panel"><h2>Extra fields on the customer card</h2>
      <ul className="list">{(data || []).map(x => <li key={x.id} className="row" style={{ padding: '6px 0' }}><span style={{ flex: 1 }}><b>{x.label}</b> <span className="muted">{x.type}{x.options?.length ? `: ${x.options.join(', ')}` : ''}</span></span>
        <button className="btn small" onClick={() => run(() => del(`/settings/fields/${x.id}`), 'Field removed').then(reload)}>Remove</button></li>)}</ul>
      {data?.length === 0 && <p className="muted">No extra fields yet. Examples: "Uniform size chart sent", "Tax exempt".</p>}
      <form className="row" style={{ marginTop: 10 }} onSubmit={e => { e.preventDefault(); run(() => post('/settings/fields', { label: f.label, type: f.type, options: f.type === 'select' ? f.options.split(',').map(s => s.trim()).filter(Boolean) : [] }), 'Field added — show it in the customer table with Columns').then(() => { setF({ label: '', type: 'text', options: '' }); reload(); }); }}>
        <input className="in" style={{ width: 220 }} placeholder="Field name" required value={f.label} onChange={e => setF({ ...f, label: e.target.value })} aria-label="Field name" />
        <select className="in" style={{ width: 'auto' }} value={f.type} onChange={e => setF({ ...f, type: e.target.value })} aria-label="Type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">Choice list</option><option value="checkbox">Yes / no</option></select>
        {f.type === 'select' && <input className="in" style={{ width: 240 }} placeholder="Choices, separated by commas" value={f.options} onChange={e => setF({ ...f, options: e.target.value })} />}
        <button className="btn primary" disabled={busy}>Add field</button></form>
    </section>
  );
}

const DEFAULT_LOOK = { fontFamily: 'atkinson', fontSize: 15, fontWeight: 400, accent: '#2E4A8B', textColor: null, density: 'comfortable', theme: 'auto' };
function Password() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  const save = async e => {
    e.preventDefault(); setErr(null);
    if (f.next !== f.again) return setErr('The new passwords do not match.');
    try { await run(() => post('/auth/password', { current: f.current, next: f.next }), 'Password changed. Other devices were signed out.'); setF({ current: '', next: '', again: '' }); }
    catch (x) { setErr(x.fieldErrors?.().next || x.message); }
  };
  return (
    <section className="panel"><h2>Password</h2>
      <form onSubmit={save} className="grid2" autoComplete="on">
        <Field label="Current password"><input className="in" type="password" autoComplete="current-password" required value={f.current} onChange={e => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters."><input className="in" type="password" autoComplete="new-password" required minLength={10} value={f.next} onChange={e => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="New password again"><input className="in" type="password" autoComplete="new-password" required value={f.again} onChange={e => setF({ ...f, again: e.target.value })} /></Field>
        <div style={{ alignSelf: 'end' }}><button className="btn primary" disabled={busy}>Change password</button></div>
      </form>
      {err && <div className="notice bad" style={{ marginTop: 10 }}>{err}</div>}
    </section>
  );
}

function Look() {
  const { me, setMe } = useSession();
  const saved = { ...DEFAULT_LOOK, ...(me.prefs || {}) };
  const [p, setP] = useState(saved);
  const [run, busy] = useAction();
  useEffect(() => () => applyPrefs(me.prefs), []); // leaving without saving restores the saved look  // eslint-disable-line
  return (
    <div style={{ display: 'grid', gap: 14 }}>
    <Password />
    <section className="panel"><h2>How the CRM looks for you</h2>
      <div className="grid2">
        <Field label="Font"><select className="in" value={p.fontFamily} onChange={e => setP({ ...p, fontFamily: e.target.value })}><option value="atkinson">Atkinson (easy to read)</option><option value="system">System</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></Field>
        <Field label={`Text size: ${p.fontSize}px`}><input type="range" min="12" max="22" value={p.fontSize} onChange={e => setP({ ...p, fontSize: Number(e.target.value) })} /></Field>
        <Field label="Text weight"><select className="in" value={p.fontWeight} onChange={e => setP({ ...p, fontWeight: Number(e.target.value) })}><option value={400}>Regular</option><option value={500}>Medium</option><option value={700}>Bold</option></select></Field>
        <Field label="Row height"><select className="in" value={p.density} onChange={e => setP({ ...p, density: e.target.value })}><option value="compact">Compact</option><option value="comfortable">Normal</option><option value="spacious">Roomy</option></select></Field>
        <Field label="Main color"><input type="color" className="in" value={p.accent} onChange={e => setP({ ...p, accent: e.target.value })} /></Field>
        <Field label="Text color"><div className="row"><input type="color" className="in" style={{ width: 80 }} value={p.textColor || '#1D2830'} onChange={e => setP({ ...p, textColor: e.target.value })} />{p.textColor && <button className="btn small" type="button" onClick={() => setP({ ...p, textColor: null })}>Use default</button>}</div></Field>
        <Field label="Light or dark"><select className="in" value={p.theme} onChange={e => setP({ ...p, theme: e.target.value })}><option value="auto">Follow my device</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => applyPrefs(p)}>Preview</button>
        <button className="btn primary" disabled={busy} onClick={() => run(() => put('/settings/prefs', p), 'Look saved').then(pr => { applyPrefs(pr); setMe({ ...me, prefs: pr }); })}>Save</button>
        <button className="btn" onClick={() => { setP(DEFAULT_LOOK); applyPrefs(DEFAULT_LOOK); }}>Reset to original</button>
      </div>
      <p className="small muted">Preview changes the screen right away; nothing is kept until you press Save. Table columns are arranged from the Columns button on each list.</p>
    </section>
    </div>
  );
}

function Replies() {
  const { data, reload } = useLoad(() => get('/inbox/canned/list'), []);
  const [f, setF] = useState({ title: '', body: '' });
  const [run, busy] = useAction();
  return (
    <section className="panel"><h2>Saved replies</h2>
      <ul className="list">{(data || []).map(r => <li key={r.id} className="row" style={{ padding: '8px 0', alignItems: 'flex-start' }}><span style={{ flex: 1 }}><b>{r.title}</b><br /><span className="muted">{r.body}</span></span><button className="btn small" onClick={() => run(() => del(`/inbox/canned/${r.id}`), 'Removed').then(reload)}>Remove</button></li>)}</ul>
      <form style={{ display: 'grid', gap: 8, marginTop: 10 }} onSubmit={e => { e.preventDefault(); run(() => post('/inbox/canned/list', f), 'Saved reply added').then(() => { setF({ title: '', body: '' }); reload(); }); }}>
        <input className="in" placeholder="Short name" required value={f.title} onChange={e => setF({ ...f, title: e.target.value })} aria-label="Reply name" />
        <textarea className="in" placeholder="Message" required value={f.body} onChange={e => setF({ ...f, body: e.target.value })} aria-label="Reply text" />
        <div><button className="btn primary" disabled={busy}>Add saved reply</button></div></form>
    </section>
  );
}

function Dnc() {
  const { can } = useSession();
  const { data, reload } = useLoad(() => get('/settings/dnc'), []);
  const [num, setNum] = useState('');
  const [run, busy] = useAction();
  return (
    <section className="panel"><h2>Do Not Call list</h2>
      <p className="muted" style={{ marginTop: -6 }}>Numbers here are never called or sent marketing. Upload a file to add many at once (one number per line). This list is yours; checking the national registry needs a separate subscription.</p>
      {can('contacts.write') && <div className="row">
        <form className="row" onSubmit={e => { e.preventDefault(); run(() => post('/settings/dnc', { phone: num }), 'Added').then(() => { setNum(''); reload(); }); }}><input className="in" type="tel" value={num} onChange={e => setNum(e.target.value)} placeholder="Phone number" aria-label="Phone number" style={{ width: 200 }} /><button className="btn primary" disabled={busy || !num}>Add</button></form>
        <label className="btn">Upload list<input type="file" hidden accept=".csv,.txt" onChange={e => { const fd = new FormData(); fd.append('file', e.target.files[0]); run(() => api('/settings/dnc', { method: 'POST', form: fd }), r => `${r.added} numbers added`).then(reload); e.target.value = ''; }} /></label></div>}
      <ul className="list" style={{ marginTop: 10 }}>{(data || []).map(d => <li key={d.phone_e164} className="row" style={{ padding: '6px 0' }}><span style={{ flex: 1 }}>{phone(d.phone_e164)} <span className="muted small">{d.source} · {dateTime(d.created_at)}</span></span>
        {can('settings.write') && <button className="btn small" onClick={() => run(() => del(`/settings/dnc/${encodeURIComponent(d.phone_e164)}`), 'Removed').then(reload)}>Remove</button>}</li>)}</ul>
      {data?.length === 0 && <p className="muted">The list is empty.</p>}
    </section>
  );
}

const JOB_NAMES = { 'message.send': 'Send message', 'natalie.reply': 'Natalie reply', 'call.post_sms': 'Text after call', 'call.summarize': 'Call summary', 'campaign.publish': 'Publish post', 'campaign.tick': 'Campaign sending', 'call.outbound_ai': 'Campaign call', 'links.check': 'Check links', 'call.start_recording': 'Start recording' };
function Failed() {
  const { data, error, reload } = useLoad(() => get('/settings/jobs?status=dead'), []);
  const [run, busy] = useAction();
  const [confirm, setConfirm] = useState(null);
  return (
    <section className="panel"><h2>Failed actions</h2>
      <p className="muted" style={{ marginTop: -6 }}>Automatic work that did not succeed after retries. Fix the cause (often a channel that is not connected), then try again.</p>
      <LoadError error={error} retry={reload} />
      {data?.rows.length === 0 && <Empty title="Nothing failed">All automatic actions went through.</Empty>}
      <ul className="list">{(data?.rows || []).map(j => <li key={j.id} style={{ padding: '10px 0' }}><div className="row"><b>{JOB_NAMES[j.kind] || j.kind}</b><span className="muted small">{dateTime(j.updated_at)} · {j.attempts} tries</span><span className="spacer" />
        <button className="btn small" disabled={busy} onClick={() => run(() => post(`/settings/jobs/${j.id}/retry`), 'Trying again').then(reload).catch(e => { if (e.code === 'confirm_needed') setConfirm(j); })}>Try again</button>
        <button className="btn small ghost" onClick={() => run(() => post(`/settings/jobs/${j.id}/dismiss`), 'Dismissed').then(reload)}>Dismiss</button></div>
        <div className="small" style={{ color: 'var(--red)' }}>{j.last_error}</div></li>)}</ul>
      {confirm && <Confirm title="Send again?" text="This message may already have reached the customer. Check the conversation first. Send again only if they did not get it." confirmLabel="Send again" onClose={() => setConfirm(null)} onConfirm={() => run(() => post(`/settings/jobs/${confirm.id}/retry`, { confirmNotDelivered: true }), 'Sending again').then(reload)} />}
    </section>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const { data, error } = useLoad(() => get(`/settings/audit${qs({ page })}`), [page]);
  return (
    <section className="panel"><h2>Activity history</h2>
      <LoadError error={error} />
      <div className="tscroll" style={{ '--t-offset': '300px' }}><table className="dt" style={{ width: '100%' }}><thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 160 }}>Who</th><th style={{ width: 200 }}>What</th><th>Details</th></tr></thead>
        <tbody>{(data || []).map(a => <tr key={a.id} style={{ cursor: 'default' }}><td>{dateTime(a.created_at)}</td><td>{a.actor_name || (a.actor_agent ? `${a.actor_agent} (AI)` : 'System')}</td><td>{a.action}</td><td className="small" title={JSON.stringify(a.after)}>{a.entity} {a.after ? JSON.stringify(a.after) : ''}</td></tr>)}</tbody></table></div>
      <div className="pager"><button className="btn small" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</button><button className="btn small" disabled={(data || []).length < 100} onClick={() => setPage(page + 1)}>Older</button></div>
    </section>
  );
}

function Data() {
  const { data, reload } = useLoad(() => get('/settings/backups'), []);
  const [run, busy] = useAction();
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="panel"><h2>Backups</h2>
        <p className="muted" style={{ marginTop: -6 }}>The server makes a backup every night and test-restores it into a scratch database to prove it works.</p>
        <button className="btn primary" disabled={busy} onClick={() => run(() => post('/settings/backups/run'), 'Backup started').then(() => setTimeout(reload, 4000))}>Back up now</button>
        <ul className="list" style={{ marginTop: 10 }}>{(data || []).map(b => <li key={b.id} className="row" style={{ padding: '6px 0' }}><span style={{ flex: 1 }}>{dateTime(b.started_at)} <span className="muted small">{b.size_bytes ? `${(b.size_bytes / 1048576).toFixed(1)} MB` : ''}</span></span>
          {b.ok === null ? <Pill>Running</Pill> : b.ok ? <Pill tone="green">Saved</Pill> : <Pill tone="red">Failed</Pill>} {b.verified ? <Pill tone="green">Restore tested</Pill> : b.ok && <Pill tone="amber">Not verified</Pill>}
          {b.detail && !b.ok && <span className="small" style={{ color: 'var(--red)' }}>{b.detail}</span>}</li>)}</ul>
        {data?.length === 0 && <p className="muted">No backups recorded yet.</p>}</section>
      <section className="panel"><h2>Export</h2>
        <div className="row"><a className="btn" href="/api/contacts/export.csv">Customers (CSV, opens in Excel)</a><a className="btn" href="/api/settings/export.json">Everything (JSON)</a></div>
        <p className="small muted">Imports are on the Leads &amp; Customers page.</p></section>
    </div>
  );
}
