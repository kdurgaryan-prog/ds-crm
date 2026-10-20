import { useState, Fragment } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, patch, post, api, del } from '../lib/api.js';
import { useLoad, LoadError, Pill, Field, Icon, useAction, Modal, Switch, Confirm } from '../components/ui.jsx';
import { useSoftphone } from '../components/Softphone.jsx';
import { useSession } from '../lib/session.jsx';
import { NewPhoneList, LogReply } from './PhoneTexts.jsx';
import { phone, dateShort, dateTime, ago, money, CHANNEL, STATUS_TONE, ORDER_TONE, leadName } from '../lib/format.js';

const STATUSES = ['New', 'Contacted', 'Waiting', 'Qualified', 'Quote Sent', 'Won', 'Lost'];
const DECOR = ['DTF printing', 'Embroidery', 'Screen printing', 'Not sure'];

export default function CustomerCard() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const sp = useSoftphone();
  const { data, error, reload } = useLoad(() => get(`/contacts/${id}`), [id]);
  const facets = useLoad(() => get('/contacts/facets'), []);
  const [tab, setTab] = useState('timeline');
  const [editing, setEditing] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [phoneText, setPhoneText] = useState(false);
  const [logReply, setLogReply] = useState(false);
  const [run, busy] = useAction();
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <div className="empty">Loading customer…</div>;
  const c = data.contact;
  if (c.id !== id) { nav(`/customers/${c.id}`, { replace: true }); return null; } // merged record
  const save = p => run(() => patch(`/contacts/${c.id}`, p), 'Saved').then(reload);
  const msgThread = data.conversations.find(x => ['sms', 'whatsapp', 'messenger', 'instagram', 'webchat'].includes(x.channel));
  const startEmail = async () => { const cv = await run(() => post('/inbox/start', { contactId: c.id, channel: 'email' })); nav(`/inbox/${cv.id}`); };
  const startSms = async () => { const cv = await run(() => post('/inbox/start', { contactId: c.id, channel: 'sms' })); nav(`/inbox/${cv.id}`); };
  const blockedCall = c.dnc || c.dnc_listed;

  return (
    <>
      <div className="page-head">
        <button className="btn ghost" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button>
        <h1>{leadName(c)}</h1>
        <span className="muted">Lead {c.lead_no}</span>
        {can('contacts.write') ? <select className="in" style={{ width: 'auto' }} value={c.status} onChange={e => save({ status: e.target.value })} aria-label="Status">{STATUSES.map(s => <option key={s}>{s}</option>)}</select> : <Pill tone={STATUS_TONE[c.status]}>{c.status}</Pill>}
      </div>
      {data.duplicates.length > 0 && <div className="notice warn" style={{ marginBottom: 12 }}>This customer may be a duplicate. <Link to="/customers?tab=duplicates">Review it</Link>.</div>}
      <div className="quick" style={{ marginBottom: 16 }}>
        {msgThread ? <Link className="btn primary" to={`/inbox/${msgThread.id}`}><Icon name="send" />Message</Link>
          : c.phone_e164 && can('inbox.reply') && <button className="btn primary" onClick={startSms}><Icon name="send" />Text</button>}
        {c.email && can('inbox.reply') && <button className="btn" disabled={!!c.email_opted_out_at} title={c.email_opted_out_at ? 'Unsubscribed from email' : ''} onClick={startEmail}>{c.email_opted_out_at ? 'Email: unsubscribed' : 'Email'}</button>}
        {c.phone_e164 && can('calls.make') && <button className="btn" disabled={blockedCall} title={blockedCall ? 'On the Do Not Call list' : ''} onClick={() => sp.open(c.phone_e164)}><Icon name="phone" />{blockedCall ? 'Do not call' : 'Call'}</button>}
        {c.phone_e164 && c.sms_marketing === 'opted_in' && !c.opted_out_at && can('inbox.reply') && <button className="btn" onClick={() => run(() => post(`/contacts/${c.id}/intro-sms`), 'Intro text queued').then(r => nav(`/inbox/${r.conversationId}`)).catch(() => {})}><Icon name="send" />Send intro text</button>}
        {c.phone_e164 && !c.opted_out_at && c.sms_marketing !== 'opted_out' && !blockedCall && can('inbox.reply') && <button className="btn" onClick={() => setPhoneText(true)}><Icon name="send" />Text from my phone</button>}
        {c.phone_e164 && can('inbox.reply') && <button className="btn" onClick={() => setLogReply(true)}>Log reply</button>}
        {can('tasks.write') && <button className="btn" onClick={() => setTaskOpen(true)}><Icon name="task" />Add task</button>}
        {can('quotes.write') && <button className="btn" onClick={() => run(() => post('/quotes', { contactId: c.id }), q => `Quote Q-${q.quote_no} started`).then(q => nav(`/quotes/${q.id}`))}><Icon name="quote" />New quote</button>}
        {can('quotes.write') && <button className="btn" onClick={() => run(() => post('/quotes/ai-draft', { contactId: c.id }), q => `Draft Q-${q.quote_no} prepared from the price list — review it`).then(q => nav(`/quotes/${q.id}`)).catch(() => {})}><Icon name="spark" />Draft quote from price list</button>}
      </div>
      <div className="card-grid">
        <div>
          <section className="panel">
            <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Details</h2><span className="spacer" />{can('contacts.write') && <button className="btn small" onClick={() => setEditing(true)}>Edit</button>}</div>
            <dl className="kv">
              <dt>Name</dt><dd>{c.name || '—'}</dd>
              {c.title && <><dt>Title</dt><dd>{c.title}</dd></>}
              <dt>Company</dt><dd>{c.company || '—'}</dd>
              {(c.address || c.city || c.zip) && <><dt>Address</dt><dd>{[c.address, c.city, [c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}{c.county && <div className="small muted">{c.county} County</div>}</dd></>}
              <dt>Phone</dt><dd>{c.phone_e164 ? <a href={`tel:${c.phone_e164}`}>{phone(c.phone_e164)}</a> : '—'}</dd>
              {c.email && <><dt>Email</dt><dd>{c.email}</dd></>}
              {data.identities.filter(i => ['instagram', 'messenger', 'whatsapp'].includes(i.kind)).map(i => <Fragment key={i.kind}><dt>{CHANNEL[i.kind]}</dt><dd>Connected</dd></Fragment>)}
              {Object.entries(c.socials || {}).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
              <dt>Source</dt><dd>{c.source || '—'}</dd>
              <dt>Responsible</dt><dd>{can('contacts.write') && facets.data ? <select className="in" value={c.owner_user_id || ''} onChange={e => save({ owner_user_id: e.target.value || null })} aria-label="Responsible">
                <option value="">Unassigned</option>{facets.data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : c.owner_name || 'Unassigned'}</dd>
              <dt>Product</dt><dd>{c.product_type || '—'}</dd>
              <dt>Quantity</dt><dd>{c.quantity ?? '—'}{c.quantity !== null && c.quantity < 20 && <> <Pill tone="amber">Below 20 minimum</Pill></>}</dd>
              <dt>Decoration</dt><dd>{c.decoration || '—'}</dd>
              <dt>Colors</dt><dd>{c.colors || '—'}</dd>
              <dt>Sizes</dt><dd>{c.sizes || '—'}</dd>
              <dt>Deadline</dt><dd>{c.deadline ? dateShort(c.deadline) : '—'}</dd>
              {c.industry && <><dt>Industry</dt><dd>{c.industry}{c.industry_type && <div className="small muted">{c.industry_type}</div>}</dd></>}
              {!c.industry && c.industry_type && <><dt>Industry type</dt><dd>{c.industry_type}</dd></>}
              {c.license_no && <><dt>License #</dt><dd>{c.license_no}</dd></>}
              {c.business_type && <><dt>Business type</dt><dd>{c.business_type}</dd></>}
              {c.other_personnel && <><dt>Other personnel</dt><dd style={{ whiteSpace: 'pre-line' }}>{c.other_personnel}</dd></>}
              {c.employees && <><dt>Employees</dt><dd>{c.employees}</dd></>}
              {c.current_apparel && <><dt>Wears now</dt><dd>{c.current_apparel}</dd></>}
              {(facets.data?.customFields || []).map(f => <Fragment key={f.key}><dt>{f.label}</dt><dd>{String(c.custom?.[f.key] ?? '—')}</dd></Fragment>)}
            </dl>
            {c.notes && <><h3 style={{ margin: '14px 0 4px' }}>Notes</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{c.notes}</p></>}
          </section>
          <Permissions c={c} save={save} canEdit={can('contacts.write')} />
          <Files c={c} files={data.files} reload={reload} canEdit={can('contacts.write')} />
          {can('contacts.delete') && <button className="btn danger small" style={{ marginTop: 14 }} onClick={() => setConfirmDel(true)}>Delete customer</button>}
        </div>
        <div className="panel">
          <div className="tabs" role="tablist">
            {[['timeline', 'History'], ['tasks', `Tasks (${data.tasks.filter(t => !t.done_at).length})`], ['quotes', `Quotes (${data.quotes.length})`], ['orders', `Orders (${data.orders.length})`], ['calls', `Calls (${data.calls.length})`], ['channels', 'Conversations']].map(([k, l]) =>
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} role="tab" aria-selected={tab === k}>{l}</button>)}
          </div>
          {tab === 'timeline' && <Timeline data={data} reload={reload} canEdit={can('contacts.write')} />}
          {tab === 'tasks' && <TaskList tasks={data.tasks} reload={reload} />}
          {tab === 'quotes' && <ul className="list">{data.quotes.length ? data.quotes.map(q => <li key={q.id}><Link to={`/quotes/${q.id}`}><b>Q-{q.quote_no}</b><span style={{ flex: 1 }}>{dateShort(q.created_at)}</span><Pill>{q.status.replace('_', ' ')}</Pill><span>{money(q.total)}</span></Link></li>) : <p className="muted">No quotes yet.</p>}</ul>}
          {tab === 'orders' && <ul className="list">{data.orders.length ? data.orders.map(o => <li key={o.id}><Link to={`/orders/${o.id}`}><b>#{o.order_no}</b><span style={{ flex: 1 }}>{o.deadline ? `Due ${dateShort(o.deadline)}` : ''}</span><Pill tone={ORDER_TONE[o.status]}>{o.status}</Pill><span>{money(o.total)}</span></Link></li>) : <p className="muted">No orders yet.</p>}</ul>}
          {tab === 'calls' && <ul className="list">{data.calls.length ? data.calls.map(cl => <li key={cl.id} style={{ padding: '8px 0' }}><div className="row"><Pill tone={cl.status === 'missed' ? 'red' : ''}>{cl.direction === 'inbound' ? 'Incoming' : 'Outgoing'}{cl.handled_by === 'ai' ? ' (AI)' : ''}</Pill><span>{dateTime(cl.created_at)}</span><span className="muted">{cl.duration_sec ? `${Math.round(cl.duration_sec / 60)} min` : cl.status}</span></div>{cl.summary && <p style={{ margin: '4px 0 0' }}>{cl.summary}</p>}{cl.outcome && <div className="small muted">Outcome: {cl.outcome}{cl.next_action ? ` — next: ${cl.next_action}` : ''}</div>}</li>) : <p className="muted">No calls yet.</p>}</ul>}
          {tab === 'channels' && <ul className="list">{data.conversations.length ? data.conversations.map(cv => <li key={cv.id}><Link to={`/inbox/${cv.id}`}><Pill tone="blue">{CHANNEL[cv.channel]}</Pill><span style={{ flex: 1 }}>{cv.ai_enabled ? 'AI on' : 'Staff handling'}{cv.needs_reply ? ' — waiting for reply' : ''}</span><span className="muted small">{ago(cv.last_message_at)}</span></Link></li>) : <p className="muted">No conversations yet.</p>}</ul>}
        </div>
      </div>
      {editing && <EditContact c={c} customFields={facets.data?.customFields || []} onClose={() => setEditing(false)} onSaved={reload} />}
      {phoneText && <NewPhoneList ids={[c.id]} onClose={() => setPhoneText(false)} />}
      {logReply && <LogReply contactId={c.id} onClose={() => setLogReply(false)} onDone={reload} />}
      {taskOpen && <TaskDialog contactId={c.id} users={facets.data?.users || []} onClose={() => setTaskOpen(false)} onSaved={reload} />}
      {confirmDel && <Confirm title="Delete this customer?" danger confirmLabel="Delete" text="The customer will be hidden from all lists. An admin can restore them from the audit log." onClose={() => setConfirmDel(false)}
        onConfirm={() => run(() => del(`/contacts/${c.id}`), 'Customer deleted').then(() => nav('/customers'))} />}
    </>
  );
}

function Permissions({ c, save, canEdit }) {
  return (
    <section className="panel">
      <h2>Contact permissions</h2>
      {(c.dnc || c.dnc_listed) && <div className="notice bad" style={{ marginBottom: 8 }}>On the Do Not Call list — calls and marketing are blocked.</div>}
      {c.opted_out_at && <div className="notice bad" style={{ marginBottom: 8 }}>Opted out {c.opt_out_channel ? `by ${CHANNEL[c.opt_out_channel] || c.opt_out_channel} ` : ''}on {dateShort(c.opted_out_at)}. Texts are blocked until they reply START.</div>}
      <div style={{ display: 'grid', gap: 10 }}>
        {c.sms_consent_at && <div className="small muted">Agreed to texts {dateShort(c.sms_consent_at)} — {c.sms_consent_source}</div>}
        <Field label="Marketing texts"><select className="in" disabled={!canEdit} value={c.sms_marketing} onChange={e => save({ sms_marketing: e.target.value })}>
          <option value="unknown">No consent on file</option><option value="opted_in">Agreed to marketing texts</option><option value="opted_out">Said no</option></select></Field>
        <Field label="Marketing calls" hint="AI calls need written consent on file."><select className="in" disabled={!canEdit} value={c.call_marketing} onChange={e => save({ call_marketing: e.target.value })}>
          <option value="unknown">No consent on file</option><option value="express_written">Written consent on file</option><option value="opted_out">Said no</option></select></Field>
        <Switch checked={c.dnc} disabled={!canEdit} onChange={v => save({ dnc: v })} label="Do not call or market" />
        <Field label="Other restrictions"><input className="in" disabled={!canEdit} defaultValue={c.restrictions || ''} placeholder="e.g. Text only after 3pm" onBlur={e => e.target.value !== (c.restrictions || '') && save({ restrictions: e.target.value })} /></Field>
      </div>
    </section>
  );
}

function Files({ c, files, reload, canEdit }) {
  const [run, busy] = useAction();
  const [kind, setKind] = useState('logo');
  const upload = async e => {
    const fd = new FormData(); for (const f of e.target.files) fd.append('files', f); fd.append('kind', kind);
    await run(() => api(`/contacts/${c.id}/files`, { method: 'POST', form: fd }), 'Uploaded').then(reload).catch(() => {});
    e.target.value = '';
  };
  return (
    <section className="panel">
      <h2>Logo and design files</h2>
      {files.length === 0 && <p className="muted">No files yet.</p>}
      <ul className="list">{files.map(f => <li key={f.id}><a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer"><Pill>{f.kind}</Pill><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.filename}</span>{f.marketing_permission === 'granted' && <Pill tone="green">OK for marketing</Pill>}</a></li>)}</ul>
      {canEdit && <div className="row" style={{ marginTop: 8 }}>
        <select className="in" style={{ width: 'auto' }} value={kind} onChange={e => setKind(e.target.value)} aria-label="File type"><option value="logo">Logo</option><option value="design">Design</option><option value="attachment">Other</option></select>
        <label className="btn"><Icon name="clip" />{busy ? 'Uploading…' : 'Upload'}<input type="file" multiple hidden onChange={upload} accept="image/*,.pdf,.ai,.eps,.svg,.psd,.zip" /></label>
      </div>}
    </section>
  );
}

function Timeline({ data, reload, canEdit }) {
  const [note, setNote] = useState('');
  const [run, busy] = useAction();
  return (
    <>
      {canEdit && <form className="row" style={{ marginBottom: 16 }} onSubmit={e => { e.preventDefault(); if (note.trim()) run(() => post(`/contacts/${data.contact.id}/notes`, { text: note }), 'Note added').then(() => { setNote(''); reload(); }); }}>
        <input className="in" style={{ flex: 1 }} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note to the history" aria-label="Note" />
        <button className="btn" disabled={busy || !note.trim()}>Add note</button></form>}
      {data.timeline.length === 0 ? <p className="muted">No history yet.</p> :
        <ul className="timeline">{data.timeline.map(a => <li key={a.id} className={`k-${a.kind}`}>
          <div>{a.summary}</div>
          <div className="when">{dateTime(a.created_at)}{a.actor_name ? ` — ${a.actor_name}` : a.actor_agent ? ` — ${a.actor_agent[0].toUpperCase() + a.actor_agent.slice(1)} (AI)` : ''}</div></li>)}</ul>}
    </>
  );
}

export function TaskList({ tasks, reload }) {
  const [run] = useAction();
  if (!tasks.length) return <p className="muted">No tasks.</p>;
  return <ul className="list">{tasks.map(t => <li key={t.id} className="row" style={{ padding: '6px 0' }}>
    <input type="checkbox" checked={!!t.done_at} onChange={e => run(() => patch(`/tasks/${t.id}`, { done: e.target.checked }), e.target.checked ? 'Task done' : 'Task reopened').then(reload)} aria-label={`Done: ${t.title}`} style={{ width: 18, height: 18 }} />
    <span style={{ flex: 1, textDecoration: t.done_at ? 'line-through' : 'none' }}>{t.title}{t.created_by_agent && <span className="muted small"> (from {t.created_by_agent})</span>}</span>
    <span className={`small ${t.due_at && !t.done_at && new Date(t.due_at) < new Date() ? '' : 'muted'}`} style={t.due_at && !t.done_at && new Date(t.due_at) < new Date() ? { color: 'var(--red)' } : null}>{t.due_at ? dateTime(t.due_at) : ''}</span></li>)}</ul>;
}

export function TaskDialog({ contactId, orderId, users = [], onClose, onSaved }) {
  const tomorrow = new Date(Date.now() + 86400000); tomorrow.setHours(10, 0, 0, 0);
  const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState({ title: '', kind: 'task', due: local(tomorrow), assignee_user_id: '' });
  const [run, busy] = useAction();
  const [errs, setErrs] = useState({});
  return (
    <Modal title="Add task" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="taskf" disabled={busy}>Add task</button></>}>
      <form id="taskf" style={{ display: 'grid', gap: 12 }} onSubmit={async e => {
        e.preventDefault();
        try { await run(() => post('/tasks', { title: f.title, kind: f.kind, due_at: f.due ? new Date(f.due).toISOString() : null, contact_id: contactId || null, order_id: orderId || null, assignee_user_id: f.assignee_user_id || null }), 'Task added'); onSaved?.(); onClose(); }
        catch (x) { setErrs(x.fieldErrors?.() || {}); }
      }}>
        <Field label="What needs to happen?" error={errs.title}><input className="in" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} required autoFocus /></Field>
        <div className="grid2">
          <Field label="Type"><select className="in" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}><option value="task">Task</option><option value="callback">Call back</option><option value="meeting">Meeting</option><option value="follow_up">Follow up</option></select></Field>
          <Field label="When"><input className="in" type="datetime-local" value={f.due} onChange={e => setF({ ...f, due: e.target.value })} /></Field>
          <Field label="Who"><select className="in" value={f.assignee_user_id} onChange={e => setF({ ...f, assignee_user_id: e.target.value })}><option value="">Me</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        </div>
      </form>
    </Modal>
  );
}

function EditContact({ c, customFields, onClose, onSaved }) {
  const [f, setF] = useState({
    name: c.name || '', company: c.company || '', phone: c.phone_raw || c.phone_e164 || '', email: c.email || '', product_type: c.product_type || '', quantity: c.quantity ?? '',
    decoration: c.decoration || '', colors: c.colors || '', sizes: c.sizes || '', deadline: c.deadline || '', industry: c.industry || '', employees: c.employees ?? '', license_no: c.license_no || '', business_type: c.business_type || '', industry_type: c.industry_type || '', other_personnel: c.other_personnel || '', title: c.title || '', address: c.address || '', city: c.city || '', county: c.county || '', zip: c.zip || '',
    current_apparel: c.current_apparel || '', notes: c.notes || '', source: c.source || '', instagram: c.socials?.instagram || '', facebook: c.socials?.facebook || '', custom: { ...(c.custom || {}) },
  });
  const [errs, setErrs] = useState({});
  const [run, busy] = useAction();
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault();
    const { instagram, facebook, ...rest } = f;
    const body = { ...rest, quantity: f.quantity === '' ? null : Number(f.quantity), employees: f.employees === '' ? null : Number(f.employees), deadline: f.deadline || null, email: f.email || null,
      socials: Object.fromEntries(Object.entries({ instagram, facebook }).filter(([, v]) => v)) };
    try { await run(() => patch(`/contacts/${c.id}`, body), 'Customer saved'); onSaved(); onClose(); }
    catch (x) { setErrs(x.fieldErrors?.() || {}); } // the form stays open with everything typed
  };
  return (
    <Modal title={`Edit Lead ${c.lead_no}`} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="editc" disabled={busy}>Save</button></>}>
      <form id="editc" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <div className="grid2">
          <Field label="Name" error={errs.name}><input className="in" value={f.name} onChange={set('name')} /></Field>
          <Field label="Company" error={errs.company}><input className="in" value={f.company} onChange={set('company')} /></Field>
          <Field label="Title" error={errs.title}><input className="in" value={f.title} onChange={set('title')} placeholder="e.g. Owner, RMO" /></Field>
          <Field label="Address" error={errs.address}><input className="in" value={f.address} onChange={set('address')} /></Field>
          <Field label="City" error={errs.city}><input className="in" value={f.city} onChange={set('city')} /></Field>
          <Field label="County" error={errs.county}><input className="in" value={f.county} onChange={set('county')} /></Field>
          <Field label="ZIP" error={errs.zip}><input className="in" inputMode="numeric" value={f.zip} onChange={set('zip')} /></Field>
          <Field label="License #" error={errs.license_no}><input className="in" value={f.license_no} onChange={set('license_no')} /></Field>
          <Field label="Business type" error={errs.business_type}><input className="in" value={f.business_type} onChange={set('business_type')} placeholder="e.g. Corporation" /></Field>
          <Field label="Industry type" error={errs.industry_type}><input className="in" value={f.industry_type} onChange={set('industry_type')} /></Field>
          <Field label="Other personnel" error={errs.other_personnel}><input className="in" value={f.other_personnel} onChange={set('other_personnel')} /></Field>
          <Field label="Phone" error={errs.phone}><input className={`in${errs.phone ? ' bad' : ''}`} type="tel" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={errs.email} hint="Only if the customer gave it, e.g. for the quote."><input className="in" type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Instagram"><input className="in" value={f.instagram} onChange={set('instagram')} placeholder="@handle" /></Field>
          <Field label="Facebook"><input className="in" value={f.facebook} onChange={set('facebook')} /></Field>
          <Field label="Source"><input className="in" value={f.source} onChange={set('source')} /></Field>
          <Field label="Industry"><input className="in" value={f.industry} onChange={set('industry')} placeholder="e.g. construction" /></Field>
          <Field label="Product"><input className="in" value={f.product_type} onChange={set('product_type')} list="products" /></Field>
          <Field label="Quantity" error={errs.quantity}><input className="in" type="number" min="0" value={f.quantity} onChange={set('quantity')} /></Field>
          <Field label="Print or embroidery"><select className="in" value={f.decoration} onChange={set('decoration')}><option value="">—</option>{DECOR.map(d => <option key={d}>{d}</option>)}</select></Field>
          <Field label="Deadline" error={errs.deadline}><input className="in" type="date" value={f.deadline} onChange={set('deadline')} /></Field>
          <Field label="Colors"><input className="in" value={f.colors} onChange={set('colors')} /></Field>
          <Field label="Sizes"><input className="in" value={f.sizes} onChange={set('sizes')} placeholder="e.g. 10 M, 15 L, 5 XL" /></Field>
          <Field label="Employees"><input className="in" type="number" min="0" value={f.employees} onChange={set('employees')} /></Field>
          <Field label="What they wear now"><input className="in" value={f.current_apparel} onChange={set('current_apparel')} /></Field>
          {customFields.map(cf => <Field key={cf.key} label={cf.label}>{
            cf.type === 'select' ? <select className="in" value={f.custom[cf.key] || ''} onChange={e => setF({ ...f, custom: { ...f.custom, [cf.key]: e.target.value } })}><option value="">—</option>{cf.options.map(o => <option key={o}>{o}</option>)}</select>
              : cf.type === 'checkbox' ? <input type="checkbox" checked={!!f.custom[cf.key]} onChange={e => setF({ ...f, custom: { ...f.custom, [cf.key]: e.target.checked } })} />
                : <input className="in" type={cf.type === 'number' ? 'number' : cf.type === 'date' ? 'date' : 'text'} value={f.custom[cf.key] ?? ''} onChange={e => setF({ ...f, custom: { ...f.custom, [cf.key]: e.target.value } })} />}</Field>)}
        </div>
        <datalist id="products">{['T-shirts', 'Polos', 'Hoodies', 'Hats', 'Safety vests', 'Workwear', 'Aprons'].map(p => <option key={p} value={p} />)}</datalist>
        <Field label="Notes"><textarea className="in" value={f.notes} onChange={set('notes')} rows={4} /></Field>
      </form>
    </Modal>
  );
}
