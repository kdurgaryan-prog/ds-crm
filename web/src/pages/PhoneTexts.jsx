// "Text from my phone": one person at a time, text filled in, one tap to open it in Messages, Enter for the next.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { useLoad, LoadError, Pill, Icon, useAction, useToast, Empty, Modal, Field } from '../components/ui.jsx';
import { phone, dateShort } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';

// iPhone/iPad Messages needs "&body="; Android and Windows Phone Link need the standard "?body=".
// The "?&body=" mix made Phone Link drop the recipient and open the last conversation instead.
const isApple = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && !/Windows/.test(navigator.userAgent);
export const smsLink = (to, body) => (isApple() ? `sms:${to}&body=${encodeURIComponent(body)}` : `sms:${to}?body=${encodeURIComponent(body)}`);

export default function PhoneTexts() {
  const { id } = useParams();
  return id ? <WorkList id={id} /> : <Lists />;
}

function Lists() {
  const { can } = useSession();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => get('/phone-texts/batches'), []);
  const [run, busy] = useAction();
  return (
    <>
      <div className="page-head"><h1>Text from my phone</h1></div>
      <p className="muted" style={{ marginTop: -4, maxWidth: 760 }}>
        The CRM picks the next person and fills in the text. You tap <b>Open in Messages</b>, press send on your phone, then <b>Sent</b> — and the next person appears.
        People who asked not to be texted, numbers on your Do Not Call list and anyone texted in the last 30 days are left out automatically.
      </p>
      <LoadError error={error} retry={reload} />
      {data && !data.length && <Empty title="No phone lists yet" action={<Link className="btn primary" to="/customers">Go to Leads &amp; Customers</Link>}>
        Filter your customers (for example by industry or source), then press <b>Text from my phone</b> above the list.</Empty>}
      {data && data.length > 0 && <div className="tscroll" style={{ '--t-offset': '260px' }}>
        <table className="dt" style={{ width: '100%' }}><thead><tr><th>List</th><th>Created</th><th>Progress</th><th>Left out</th><th /></tr></thead>
          <tbody>{data.map(b => {
            const left = Object.values(b.excluded || {}).reduce((a, n) => a + n, 0);
            return (
              <tr key={b.id}>
                <td><b>{b.name}</b>{b.created_by_name && <div className="small muted">by {b.created_by_name}</div>}</td>
                <td className="nowrap">{dateShort(b.created_at)}</td>
                <td><span className="nowrap"><Progress b={b} /> {b.sent} sent{b.skipped ? `, ${b.skipped} skipped` : ''} of {b.total}</span>{b.skip_reasons && <div className="small muted">Skipped: {Object.entries(b.skip_reasons).map(([k, n]) => `${k} (${n})`).join(', ')}</div>}</td>
                <td className="small" title={Object.entries(b.excluded || {}).map(([k, n]) => `${k}: ${n}`).join('\n')}>{left ? `${left} people` : '—'}</td>
                <td className="nowrap" style={{ textAlign: 'right' }}>
                  {!b.closed_at && b.pending > 0 ? <>
                    <Link className="btn primary small" to={`/phone-texts/${b.id}`}>{b.sent ? 'Continue' : 'Start'}</Link>{' '}
                    <button className="btn small" disabled={busy} onClick={() => run(() => post(`/phone-texts/batches/${b.id}/close`), 'List closed').then(reload)}>Close</button></> : <>
                    {b.sent > 0 ? <Pill tone="green">✓ Sent</Pill> : <Pill>Closed</Pill>}{' '}
                    {can('settings.write') && b.sent + b.skipped > 0 && <button className="btn small" disabled={busy} onClick={() => run(() => post(`/phone-texts/batches/${b.id}/again`), r => `New list "${r.batch.name}" with ${r.added} people`).then(r => nav(`/phone-texts/${r.batch.id}`)).catch(() => {})}>Send again</button>}</>}
                </td>
              </tr>);
          })}</tbody></table></div>}
    </>
  );
}

function Progress({ b }) {
  const pct = b.total ? Math.round(((b.sent + b.skipped) / b.total) * 100) : 0;
  return <span style={{ display: 'inline-block', width: 80, height: 6, borderRadius: 3, background: 'var(--line)', verticalAlign: 'middle', overflow: 'hidden' }}>
    <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--accent)' }} /></span>;
}

function WorkList({ id }) {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [last, setLast] = useState(null);
  const sentBtn = useRef(null);
  const load = useCallback(async () => {
    setError(null); setOpened(false);
    try { setState(await get(`/phone-texts/batches/${id}/next`)); } catch (e) { setError(e); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, msg) => { setBusy(true); try { await fn(); if (msg) toast.ok(msg); await load(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const item = state?.item;
  const who = it => it.contact.name || it.contact.company || 'this person';
  const markSent = () => { if (!item || busy) return; const it = item; act(async () => { await post(`/phone-texts/items/${it.id}/sent`); setLast({ id: it.id, name: who(it), what: 'marked as sent' }); }); };
  const skip = reason => { setSkipOpen(false); const it = item; act(async () => { await post(`/phone-texts/items/${it.id}/skip`, { reason }); setLast({ id: it.id, name: who(it), what: 'skipped' }); }, 'Skipped'); };
  const undo = () => { const l = last; act(async () => { await post(`/phone-texts/items/${l.id}/undo`); setLast(null); }, `${l.name} is back in the list`); };
  useEffect(() => {
    const k = e => {
      if (/input|textarea|select/i.test(document.activeElement?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter' && item) { e.preventDefault(); markSent(); }
    };
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k);
  });
  const copy = async (t, what) => { try { await navigator.clipboard.writeText(t); toast.ok(`${what} copied`); setOpened(true); } catch { toast.error({ message: 'Copy is blocked by the browser — select the text and copy it.' }); } };

  if (error) return <LoadError error={error} retry={load} />;
  if (!state) return <div className="empty">Loading…</div>;
  const c = state.counts;
  return (
    <>
      <div className="page-head">
        <Link className="btn ghost" to="/phone-texts" aria-label="Back to lists"><Icon name="back" /></Link>
        <h1>{state.batch.name}</h1>
        <span className="muted">{c.sent} sent · {c.skipped} skipped · {c.pending} left</span>
        <span className="spacer" />
        <Pill tone={state.sentToday >= state.dailyLimit ? 'red' : ''}>Today {state.sentToday} / {state.dailyLimit}</Pill>
      </div>
      {last && <div className="notice" style={{ maxWidth: 640, marginBottom: 10 }}>{last.name} {last.what}. <button className="btn small" disabled={busy} onClick={undo}>Undo — it did not go out</button></div>}
      {state.paused && <div className="notice warn">{state.paused}</div>}
      {state.waiting && <div className="notice">{state.waiting} <button className="btn small" onClick={load}>Check again</button></div>}
      {state.done && <Empty title="This list is finished" action={<Link className="btn primary" to="/phone-texts">Back to lists</Link>}>{c.sent} texts sent, {c.skipped} skipped. Replies come to your phone — when someone answers, open their card and press <b>Log reply</b>.</Empty>}
      {item && (
        <section className="panel" style={{ maxWidth: 640 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="muted">#{item.position}</span>
            <Link to={`/customers/${item.contact.id}`} target="_blank"><b>Lead {item.contact.lead_no}</b></Link>
            {item.contact.industry && <Pill>{item.contact.industry}</Pill>}
          </div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>{item.contact.name || item.contact.company || 'No name'}</div>
          {item.contact.name && item.contact.company && <div className="muted">{item.contact.company}</div>}
          <div style={{ fontSize: 24, fontWeight: 700, margin: '10px 0', letterSpacing: '.02em' }}>{phone(item.contact.phone_e164)}</div>
          <Field label="Text"><textarea className="in" rows={5} readOnly value={item.body} /></Field>
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            <a className="btn primary" style={{ fontSize: 16, padding: '10px 16px' }} href={smsLink(item.contact.phone_e164, item.body)} onClick={() => { navigator.clipboard?.writeText(item.body).catch(() => {}); setOpened(true); setTimeout(() => sentBtn.current?.focus(), 50); }}>
              <Icon name="send" />Open in Messages</a>
            <button className="btn" onClick={() => copy(item.contact.phone_e164, 'Number')}>Copy number</button>
            <button className="btn" onClick={() => copy(item.body, 'Text')}>Copy text</button>
          </div>
          <div className="row" style={{ marginTop: 16, gap: 8 }}>
            <button ref={sentBtn} className={`btn ${opened ? 'primary' : ''}`} disabled={busy} onClick={markSent}><Icon name="check" />Sent — next <span className="small muted" style={{ marginLeft: 6 }}>Enter</span></button>
            <button className="btn" disabled={busy} onClick={() => setSkipOpen(true)}>Skip</button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Press <b>Sent</b> only after the text left your phone. On a computer, <b>Open in Messages</b> uses Phone Link (Windows) or Messages (Mac); on a phone, open this page in the phone's browser. The text is also copied — if it isn't filled in, press Ctrl+V in the message box.</p>
        </section>
      )}
      {skipOpen && <Modal title="Skip this person" onClose={() => setSkipOpen(false)} footer={<button className="btn" onClick={() => setSkipOpen(false)}>Cancel</button>}>
        <div style={{ display: 'grid', gap: 8 }}>
          {['Not a mobile number', 'Wrong number', 'Not a good fit', 'Skip for now'].map(r => <button key={r} className="btn" onClick={() => skip(r)}>{r}</button>)}
        </div>
      </Modal>}
    </>
  );
}

/** "Text from my phone" from the customer list (current filters) or one customer card. */
export function NewPhoneList({ filters, ids, count, defaultName, onClose }) {
  const nav = useNavigate();
  const [name, setName] = useState(defaultName || '');
  const [res, setRes] = useState(null);
  const [run, busy] = useAction();
  const { can } = useSession();
  const create = (allowRepeat = false) => run(() => post('/phone-texts/batches', { name: name || undefined, ...(ids ? { ids } : { filters }), ...(allowRepeat ? { allowRepeat: true } : {}) })).then(r => {
    if (r.batch && ids?.length === 1) nav(`/phone-texts/${r.batch.id}`); else setRes(r);
  }).catch(() => {});
  const left = res ? Object.entries(res.excluded || {}) : [];
  const repeatable = left.filter(([k]) => k.startsWith('Already texted')).reduce((a, [, n]) => a + n, 0);
  return (
    <Modal title="Text from my phone" onClose={onClose} footer={res ? <>
      <button className="btn" onClick={onClose}>Close</button>
      {!res.batch && res.openListId && <button className="btn primary" onClick={() => nav(`/phone-texts/${res.openListId}`)}>Open that list</button>}
      {!res.batch && !res.openListId && repeatable > 0 && can('settings.write') && <button className="btn primary" disabled={busy} onClick={() => create(true)}>Text them again anyway</button>}
      {res.batch && <button className="btn primary" onClick={() => nav(`/phone-texts/${res.batch.id}`)}>Start texting</button>}</> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={() => create()}>Make the list</button></>}>
      {!res ? <>
        <p style={{ marginTop: 0 }}>{ids?.length === 1 ? 'Text this customer from your own phone.' : <>Make a phone list from the <b>{count?.toLocaleString()}</b> customers shown with your current filters.</>} The text comes from <i>Settings → "Text from my phone" message</i>.</p>
        {!(ids?.length === 1) && <Field label="List name" hint="For example: Contractors – Los Angeles"><input className="in" value={name} onChange={e => setName(e.target.value)} maxLength={120} autoFocus /></Field>}
        <p className="small muted" style={{ marginBottom: 0 }}>Left out automatically: people who asked not to be texted, Do Not Call numbers, customers without a phone, anyone texted in the last 30 days and anyone already in another open list.</p>
      </> : <>
        <div className={`notice ${res.added ? 'good' : 'warn'}`}>{res.added ? <><b>{res.added}</b> people are ready to text.</> : 'Nobody in this selection can be texted right now.'}</div>
        {left.length > 0 && <div className="small" style={{ marginTop: 8 }}>Left out: {left.map(([k, n]) => `${k} (${n})`).join(', ')}</div>}
        {!res.batch && repeatable > 0 && <div className="small muted" style={{ marginTop: 8 }}>{can('settings.write') ? 'Text them again anyway makes a list with these people. People who asked not to be texted and Do Not Call numbers stay out.' : 'Ask the owner or an admin to text these people again before the waiting period ends.'}</div>}
      </>}
    </Modal>
  );
}

/** A reply that came to someone's own phone, copied into the CRM. "STOP" marks the person as opted out. */
export function LogReply({ contactId, onClose, onDone }) {
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  return (
    <Modal title="Log a reply from my phone" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !text.trim()} onClick={() => run(() => post(`/contacts/${contactId}/phone-reply`, { text }), r => (r.optedOut ? 'Saved. They asked not to be texted — removed from all phone lists.' : 'Reply saved on the timeline')).then(() => { onDone?.(); onClose(); }).catch(() => {})}>Save</button></>}>
      <Field label="What they wrote" hint='If they wrote STOP or similar, they are marked "Asked not to be texted" and never added to a phone list again.'>
        <textarea className="in" rows={4} value={text} onChange={e => setText(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
