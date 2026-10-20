import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post, api, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, Icon, useAction, Empty, Switch, useToast } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { CHANNEL, MSG_STATUS, ago, dateTime, phone, leadName } from '../lib/format.js';

export default function Inbox() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const filters = { channel: sp.get('channel') || '', status: sp.get('status') || '', assignee: sp.get('assignee') || '', needs_reply: sp.get('needs_reply') || '', q: sp.get('q') || '' };
  const list = useLoad(() => get(`/inbox${qs(filters)}`), [JSON.stringify(filters), id]);
  useEffect(() => { const t = setInterval(list.reload, 15000); return () => clearInterval(t); }, [list.reload]);
  const setF = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  return (
    <>
      <div className="page-head"><h1>Inbox</h1>
        <select className="in" style={{ width: 'auto' }} value={filters.channel} onChange={e => setF('channel', e.target.value)} aria-label="Channel"><option value="">All channels</option>{Object.entries(CHANNEL).filter(([k]) => k !== 'mms' && k !== 'voice').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="in" style={{ width: 'auto' }} value={filters.status} onChange={e => setF('status', e.target.value)} aria-label="Status"><option value="">Open and waiting</option><option value="open">Open</option><option value="pending">Waiting</option><option value="done">Done</option></select>
        <select className="in" style={{ width: 'auto' }} value={filters.assignee} onChange={e => setF('assignee', e.target.value)} aria-label="Assigned"><option value="">Everyone</option><option value="me">Mine</option><option value="none">Unassigned</option></select>
        <label className="row small"><input type="checkbox" checked={filters.needs_reply === '1'} onChange={e => setF('needs_reply', e.target.checked ? '1' : '')} /> Needs reply</label>
        {Object.values(filters).some(Boolean) && <button className="btn small" onClick={() => setSp({}, { replace: true })}>Clear filters</button>}
      </div>
      <LoadError error={list.error} retry={list.reload} />
      <div className={`inbox${id ? ' has-thread' : ''}`}>
        <div className="convs">
          {list.data?.rows.length === 0 && <Empty title="Nothing waiting">New messages from SMS, WhatsApp, Messenger, Instagram and your website arrive here.</Empty>}
          {list.data?.rows.map(cv => (
            <button key={cv.id} className={`conv${cv.id === id ? ' on' : ''}${cv.needs_reply ? ' need' : ''}`} onClick={() => nav(`/inbox/${cv.id}${location.search}`)}>
              <Pill tone="blue">{CHANNEL[cv.channel]}</Pill>
              <span className="who">{cv.contact_name || cv.company || (cv.phone_e164 ? phone(cv.phone_e164) : `Lead ${cv.lead_no}`)}</span>
              <span className="muted small nowrap">{ago(cv.last_message_at)}</span>
              <span className="prev">{cv.last_direction === 'out' ? 'You: ' : ''}{cv.last_body || '[attachment]'}</span>
              <span style={{ gridColumn: '2 / 4' }} className="row small">
                {cv.ai_enabled ? <Pill tone="amber">AI answering</Pill> : <Pill>{cv.assignee_name || 'Staff'}</Pill>}
                {cv.status === 'pending' && <Pill>Waiting</Pill>}
                {cv.last_out_status === 'failed' && <Pill tone="red">Not delivered</Pill>}
              </span>
            </button>
          ))}
        </div>
        <div className="thread">{id ? <Thread id={id} onChange={list.reload} /> : <Empty title="Choose a conversation">Pick a conversation on the left to read and reply.</Empty>}</div>
      </div>
    </>
  );
}

function Thread({ id, onChange }) {
  const nav = useNavigate();
  const { can, me } = useSession();
  const toast = useToast();
  const { data, error, reload } = useLoad(() => get(`/inbox/${id}`), [id]);
  const canned = useLoad(() => get('/inbox/canned/list'), []);
  const users = useLoad(() => get('/contacts/facets'), []);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [subject, setSubject] = useState('');
  const [suggestion, setSuggestion] = useState(null);
  const [run, busy] = useAction();
  const end = useRef(null);
  const draftKey = `draft:${id}`;
  useEffect(() => { try { setText(sessionStorage.getItem(draftKey) || ''); } catch { setText(''); } setSuggestion(null); setFiles([]); }, [id]); // eslint-disable-line
  useEffect(() => { try { sessionStorage.setItem(draftKey, text); } catch { /* ignore */ } }, [text]); // eslint-disable-line
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.messages?.length]);
  useEffect(() => { const t = setInterval(reload, 8000); return () => clearInterval(t); }, [reload]);
  if (error) return <div style={{ padding: 16 }}><LoadError error={error} retry={reload} /></div>;
  if (!data) return <div className="empty">Loading…</div>;
  const { conversation: cv, contact: c, messages, replyWindow } = data;
  const update = (body, msg) => run(() => patch(`/inbox/${cv.id}`, body), msg).then(() => { reload(); onChange(); });
  const send = async () => {
    const fd = new FormData(); fd.append('body', text); if (subject) fd.append('subject', subject); for (const f of files) fd.append('files', f);
    const key = `${cv.id}-${Date.now()}`;
    try {
      const m = await api(`/inbox/${cv.id}/reply`, { method: 'POST', form: fd, headers: { 'idempotency-key': key } });
      setText(''); setFiles([]); setSuggestion(null);
      toast.ok(m.status === 'queued' ? 'Sending…' : 'Saved');
    } catch (e) { toast.error(e); } // text stays in the box
    reload(); onChange();
  };
  const formOnly = cv.channel === 'website_forms';
  return (
    <>
      <div className="thread-head">
        <button className="btn ghost show-sm" onClick={() => nav('/inbox')} aria-label="Back to list"><Icon name="back" /></button>
        <div style={{ minWidth: 0 }}><Link to={`/customers/${c.id}`}><b>{leadName(c)}</b></Link> <span className="muted">Lead {c.lead_no}{c.company && c.name ? ` — ${c.company}` : ''}</span><br />
          <span className="small muted">{CHANNEL[cv.channel]}{cv.channel === 'email' ? ` · ${cv.external_thread_id}` : c.phone_e164 ? ` · ${phone(c.phone_e164)}` : ''}</span></div>
        <span className="spacer" />
        {can('inbox.reply') && !formOnly && <Switch checked={cv.ai_enabled} onChange={v => update({ ai_enabled: v }, v ? `${me.agents.natalie} will answer this conversation` : `${me.agents.natalie} paused for this conversation`)} label={`${me.agents.natalie} answers`} />}
        {can('inbox.reply') && <select className="in" style={{ width: 'auto' }} value={cv.assignee_user_id || ''} onChange={e => update({ assignee_user_id: e.target.value || null }, 'Conversation transferred')} aria-label="Assign to">
          <option value="">Unassigned</option>{users.data?.users.filter(u => u.role !== 'viewer' && u.role !== 'marketing').map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        {can('inbox.reply') && <div className="seg">{[['open', 'Open'], ['pending', 'Waiting'], ['done', 'Done']].map(([k, l]) => <button key={k} className={cv.status === k ? 'on' : ''} onClick={() => update({ status: k }, `Marked ${l.toLowerCase()}`)}>{l}</button>)}</div>}
      </div>
      {!cv.ai_enabled && cv.ai_paused_reason && <div className="notice small" style={{ margin: '8px 14px 0' }}>{me.agents.natalie} is paused here: {cv.ai_paused_reason}. Turn her back on with the switch above.</div>}
      <div className="msgs" aria-live="polite">
        {messages.map(m => {
          const [label, tone] = MSG_STATUS[m.status] || [m.status, ''];
          const who = m.direction === 'in' ? null : m.author_type === 'ai' ? me.agents.natalie + ' (AI)' : m.author_type === 'system' ? 'Automatic' : m.author_name || 'Staff';
          return (
            <div key={m.id} className={`msg ${m.direction === 'out' ? 'out' : ''}${m.author_type === 'ai' ? ' ai' : ''}${['failed', 'blocked'].includes(m.status) ? ' bad' : ''}`}>
              {m.subject && cv.channel === 'email' && <div style={{ fontWeight: 650, marginBottom: 4 }}>{m.subject}</div>}
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              {(m.media || []).map((x, i) => x.fileId ? <div key={i}><a href={`/api/files/${x.fileId}`} target="_blank" rel="noreferrer">{(x.mime || '').startsWith('image/') ? <img src={`/api/files/${x.fileId}`} alt={x.filename || 'attachment'} style={{ maxWidth: 220, borderRadius: 8, marginTop: 6 }} /> : (x.filename || 'Attachment')}</a></div> : <div key={i} className="small muted">[attachment]</div>)}
              <div className="meta">{who && <span>{who}</span>}<span>{dateTime(m.created_at)}</span>{m.direction === 'out' && <Pill tone={tone}>{label}</Pill>}</div>
              {m.status_detail && ['failed', 'blocked', 'unknown', 'queued'].includes(m.status) && <div className="small" style={{ color: m.status === 'queued' ? 'var(--ink-3)' : 'var(--red)', marginTop: 4 }}>{m.status_detail}</div>}
              {['failed', 'unknown'].includes(m.status) && can('inbox.reply') && <button className="btn small" style={{ marginTop: 6 }} onClick={() => { if (m.status === 'unknown' && !window.confirm('This message may already have reached the customer. Send it again anyway?')) return; run(() => post(`/inbox/${cv.id}/retry/${m.id}`, { confirmNotDelivered: m.status === 'unknown' }), 'Trying again').then(reload); }}>{m.status === 'unknown' ? 'Resend (check first)' : 'Try again'}</button>}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {can('inbox.reply') && (formOnly ? (
        <div className="composer"><div className="notice">This request came from the website form. Reply by text or call the customer.</div>
          <div className="row">{c.phone_e164 && <button className="btn primary" onClick={() => run(() => post('/inbox/start', { contactId: c.id, channel: 'sms' })).then(x => nav(`/inbox/${x.id}`))}>Start SMS conversation</button>}<Link className="btn" to={`/customers/${c.id}`}>Open customer</Link></div></div>
      ) : (
        <div className="composer">
          {!replyWindow.open && <div className="notice warn small">{replyWindow.reason}</div>}
          {replyWindow.staffOnly && <div className="notice small">More than 24 hours since the customer wrote: only staff replies are allowed (sent as a human-agent reply).</div>}
          {suggestion && <div className="suggest"><div className="small muted">Suggested by {me.agents.natalie} — edit before sending</div><div style={{ whiteSpace: 'pre-wrap' }}>{suggestion}</div>
            <div className="row" style={{ marginTop: 6 }}><button className="btn small" onClick={() => { setText(suggestion); setSuggestion(null); }}>Use this</button><button className="btn small ghost" onClick={() => setSuggestion(null)}>Dismiss</button></div></div>}
          {cv.channel === 'email' && !messages.some(m => m.subject) && <input className="in" style={{ marginBottom: 6 }} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" maxLength={200} />}
          <textarea className="in" rows={cv.channel === 'email' ? 7 : 3} value={text} onChange={e => setText(e.target.value)} placeholder={`Reply by ${CHANNEL[cv.channel]}…`} aria-label="Reply"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
          {files.length > 0 && <div className="row small">{files.map((f, i) => <Pill key={i}>{f.name} <button className="btn ghost small" style={{ minHeight: 0, padding: 0 }} onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>×</button></Pill>)}</div>}
          <div className="row">
            <label className="btn"><Icon name="clip" />Attach<input type="file" hidden multiple accept="image/*,.pdf" onChange={e => setFiles([...files, ...e.target.files])} /></label>
            {canned.data?.length > 0 && <select className="in" style={{ width: 'auto' }} value="" onChange={e => { const r = canned.data.find(x => x.id === e.target.value); if (r) setText(t => (t ? t + '\n' : '') + r.body); }} aria-label="Saved replies"><option value="">Saved replies…</option>{canned.data.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select>}
            {data.aiAvailable && <button className="btn" disabled={busy} onClick={() => run(() => post(`/inbox/${cv.id}/suggest`)).then(r => setSuggestion(r.text)).catch(() => {})}><Icon name="spark" />Suggest reply</button>}
            <span className="spacer" />
            <button className="btn primary" disabled={(!text.trim() && !files.length) || !replyWindow.open} onClick={send}><Icon name="send" />Send</button>
          </div>
          {cv.ai_enabled && <div className="small muted">Sending a reply yourself pauses {me.agents.natalie} in this conversation.</div>}
        </div>
      ))}
    </>
  );
}
