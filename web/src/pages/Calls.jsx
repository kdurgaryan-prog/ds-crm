import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, patch, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, Modal, Field, useAction, Empty, Icon } from '../components/ui.jsx';
import { useSoftphone } from '../components/Softphone.jsx';
import { useSession } from '../lib/session.jsx';
import { dateTime, phone, leadName } from '../lib/format.js';

export default function Calls() {
  const [sp, setSp] = useSearchParams();
  const filter = sp.get('filter') || '';
  const { can } = useSession();
  const soft = useSoftphone();
  const { data, error, reload } = useLoad(() => get(`/calls${qs({ filter })}`), [filter]);
  const [open, setOpen] = useState(null);
  return (
    <>
      <div className="page-head"><h1>Calls</h1>
        <div className="seg">{[['', 'All'], ['missed', 'Missed'], ['inbound', 'Incoming'], ['outbound', 'Outgoing'], ['ai', 'Answered by AI']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setSp(k ? { filter: k } : {})}>{l}</button>)}</div>
        {can('calls.make') && <button className="btn primary" onClick={() => soft.open()}><Icon name="phone" />Open phone</button>}
      </div>
      <LoadError error={error} retry={reload} />
      {data && (data.rows.length === 0 ? <Empty title={filter === 'missed' ? 'No missed calls' : 'No calls yet'}>Calls to and from your business number appear here with their outcome.</Empty> :
        <div className="tscroll" style={{ '--t-offset': '200px' }}><table className="dt" style={{ width: '100%' }}>
          <thead><tr><th style={{ width: 160 }}>When</th><th style={{ width: 200 }}>Customer</th><th style={{ width: 130 }}>Type</th><th style={{ width: 110 }}>Length</th><th>Summary and outcome</th><th style={{ width: 120 }}></th></tr></thead>
          <tbody>{data.rows.map(cl => (
            <tr key={cl.id} onClick={() => setOpen(cl.id)}>
              <td>{dateTime(cl.created_at)}</td>
              <td>{cl.contact_id ? <Link to={`/customers/${cl.contact_id}`} onClick={e => e.stopPropagation()}>{leadName({ name: cl.contact_name, company: cl.company, lead_no: cl.lead_no })}</Link> : phone(cl.direction === 'inbound' ? cl.from_number : cl.to_number)}</td>
              <td>{['missed', 'no-answer', 'busy'].includes(cl.status) ? <Pill tone="red">Missed</Pill> : cl.status === 'sandbox' ? <Pill tone="amber">Test only</Pill> : <Pill>{cl.direction === 'inbound' ? 'Incoming' : 'Outgoing'}</Pill>} {cl.handled_by === 'ai' && <Pill tone="amber">AI</Pill>}</td>
              <td>{cl.duration_sec ? `${Math.floor(cl.duration_sec / 60)}:${String(cl.duration_sec % 60).padStart(2, '0')}` : '—'}</td>
              <td style={{ whiteSpace: 'normal' }}>{cl.outcome ? <b>{cl.outcome}. </b> : null}{cl.summary || (cl.handoff_reason ? `Transferred: ${cl.handoff_reason}` : <span className="muted">No summary</span>)}{cl.next_action && <span className="muted"> Next: {cl.next_action}</span>}</td>
              <td>{can('calls.make') && (cl.contact_id || cl.from_number) && <button className="btn small" onClick={e => { e.stopPropagation(); soft.open(cl.direction === 'inbound' ? cl.from_number : cl.to_number); }}>Call back</button>}</td>
            </tr>))}</tbody></table></div>)}
      {open && <CallDetail id={open} onClose={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function CallDetail({ id, onClose }) {
  const { can } = useSession();
  const { data } = useLoad(() => get(`/calls/${id}`), [id]);
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  if (!data) return null;
  const form = f || { outcome: data.outcome || '', next_action: data.next_action || '', callbackAt: '' };
  return (
    <Modal title={`Call with ${data.contact_name || phone(data.from_number)}`} onClose={onClose} wide footer={can('calls.make') && <><button className="btn" onClick={onClose}>Close</button>
      <button className="btn primary" disabled={busy} onClick={() => run(() => patch(`/calls/${id}`, { outcome: form.outcome || null, next_action: form.next_action || null, callbackAt: form.callbackAt ? new Date(form.callbackAt).toISOString() : undefined }), 'Call updated').then(onClose)}>Save outcome</button></>}>
      <div className="row">{dateTime(data.created_at)} <Pill>{data.direction}</Pill> {data.handled_by === 'ai' && <Pill tone="amber">Answered by AI</Pill>} {data.handoff_reason && <Pill tone="blue">Transferred: {data.handoff_reason}</Pill>}</div>
      {data.recording_url && <audio controls src={`/api/calls/${id}/recording`} style={{ width: '100%' }} />}
      {data.summary && <div className="notice"><b>Summary</b><div>{data.summary}</div></div>}
      {data.post_call_sms && <div className="small">Follow-up text: {data.post_sms_message ? `${data.post_sms_message.status}${data.post_sms_message.status_detail ? ` — ${data.post_sms_message.status_detail}` : ''}` : data.post_call_sms}</div>}
      {data.transcript?.length > 0 && <details><summary>Transcript ({data.transcript.length} lines)</summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>{data.transcript.map((t, i) => <div key={i}><b>{t.who === 'ai' ? 'Natalie' : 'Caller'}:</b> {t.text}</div>)}</div></details>}
      {can('calls.make') && <div className="grid2">
        <Field label="Outcome"><input className="in" list="outcomes" value={form.outcome} onChange={e => setF({ ...form, outcome: e.target.value })} /></Field>
        <Field label="Next step"><input className="in" value={form.next_action} onChange={e => setF({ ...form, next_action: e.target.value })} /></Field>
        <Field label="Schedule a callback"><input className="in" type="datetime-local" value={form.callbackAt} onChange={e => setF({ ...form, callbackAt: e.target.value })} /></Field>
        <datalist id="outcomes">{['Interested', 'Quote requested', 'Not interested', 'Call back later', 'Left voicemail', 'Wrong number', 'Order placed'].map(o => <option key={o} value={o} />)}</datalist>
      </div>}
    </Modal>
  );
}
