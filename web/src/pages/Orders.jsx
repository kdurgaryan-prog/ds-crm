import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post, api, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, Field, useAction, Empty, Icon, Modal } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { money, dateShort, dateTime, daysUntil, ORDER_TONE, leadName } from '../lib/format.js';
import { TaskList, TaskDialog } from './CustomerCard.jsx';

export default function Orders() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const status = sp.get('status') || ''; const due = sp.get('due') || '';
  const { data, error, reload } = useLoad(() => get(`/orders${qs({ status, due })}`), [status, due]);
  const [view, setView] = useState('board');
  return (
    <>
      <div className="page-head"><h1>Orders</h1>
        <div className="seg"><button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>By stage</button><button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button></div>
        <select className="in" style={{ width: 'auto' }} value={status ? status : due ? 'week' : ''} onChange={e => setSp(e.target.value === 'week' ? { due: 'week' } : e.target.value ? { status: e.target.value } : {})} aria-label="Show">
          <option value="">Open orders</option><option value="week">Due within 7 days</option><option value="Delivered">Delivered</option><option value="Canceled">Canceled</option></select>
        {(status || due) && <button className="btn" onClick={() => setSp({})}>Clear filters</button>}
      </div>
      <LoadError error={error} retry={reload} />
      {data && (data.rows.length === 0 ? <Empty title="No orders here">Approved quotes become orders with one click.</Empty> : view === 'board' ? (
        <div className="board">{data.flow.filter(s => status || data.rows.some(r => r.status === s) || !['Delivered'].includes(s)).map(s => {
          const rows = data.rows.filter(r => r.status === s);
          if (status && !rows.length) return null;
          return <div key={s} className="col"><h3><span>{s}</span><span className="muted">{rows.length}</span></h3>
            {rows.map(o => <OrderCard key={o.id} o={o} onClick={() => nav(`/orders/${o.id}`)} />)}</div>;
        })}</div>
      ) : (
        <div className="tscroll" style={{ '--t-offset': '200px' }}><table className="dt" style={{ width: '100%' }}>
          <thead><tr><th style={{ width: 80 }}>Order</th><th>Customer</th><th style={{ width: 170 }}>Stage</th><th style={{ width: 110 }}>Payment</th><th style={{ width: 110 }}>Total</th><th style={{ width: 120 }}>Deadline</th></tr></thead>
          <tbody>{data.rows.map(o => <tr key={o.id} onClick={() => nav(`/orders/${o.id}`)}><td><b>#{o.order_no}</b></td><td>{o.company || o.contact_name}</td><td><Pill tone={ORDER_TONE[o.status]}>{o.status}</Pill></td><td>{o.payment_status}</td><td>{money(o.total)}</td><td>{dateShort(o.deadline)}</td></tr>)}</tbody></table></div>
      ))}
    </>
  );
}

function OrderCard({ o, onClick }) {
  const d = daysUntil(o.deadline);
  return <div className="bcard" onClick={onClick} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}>
    <div className="row"><b>#{o.order_no}</b><span className="spacer" />{o.deadline && <Pill tone={d < 0 ? 'red' : d <= 3 ? 'amber' : ''}>{d < 0 ? `${-d}d late` : `Due ${dateShort(o.deadline)}`}</Pill>}</div>
    <div>{o.company || o.contact_name}</div>
    <div className="small muted">{money(o.total)} · {o.payment_status}{o.designs ? ` · design v${o.designs}${o.design_approved_at ? ' approved' : ''}` : ''}</div>
  </div>;
}

export function OrderDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const { data: o, error, reload } = useLoad(() => get(`/orders/${id}`), [id]);
  const [run, busy] = useAction();
  const [approve, setApprove] = useState(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [notes, setNotes] = useState(null);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!o) return <div className="empty">Loading order…</div>;
  const edit = can('orders.write');
  const setStatus = async s => {
    try { await run(() => patch(`/orders/${id}`, { status: s }), `Moved to ${s}`); }
    catch (e) { if (e.code === 'design_not_approved' && confirm('The customer has not approved a design. Start production anyway?')) await run(() => api(`/orders/${id}`, { method: 'PATCH', body: { status: s, override: true } }), `Moved to ${s}`); }
    reload();
  };
  const upload = async e => { const fd = new FormData(); fd.append('file', e.target.files[0]); fd.append('notes', ''); await run(() => api(`/orders/${id}/designs`, { method: 'POST', form: fd }), 'Design version added').catch(() => {}); e.target.value = ''; reload(); };
  const idx = o.flow.indexOf(o.status);
  return (
    <>
      <div className="page-head"><button className="btn ghost" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button><h1>Order #{o.order_no}</h1><Pill tone={ORDER_TONE[o.status]}>{o.status}</Pill>
        <span className="muted">for <Link to={`/customers/${o.contact_id}`}>{leadName({ name: o.contact_name, company: o.company, lead_no: o.lead_no })}</Link>{o.quote_no ? ` · from quote Q-${o.quote_no}` : ''}</span></div>
      <section className="panel">
        <h2>Stage</h2>
        <div className="row" role="group" aria-label="Order stage">
          {o.flow.map((s, i) => <button key={s} disabled={!edit || busy} className={`btn small${s === o.status ? ' primary' : ''}`} style={i < idx ? { opacity: .7 } : null} onClick={() => s !== o.status && setStatus(s)}>{i < idx ? <Icon name="check" /> : null}{s}</button>)}
        </div>
        {edit && idx < o.flow.length - 1 && <button className="btn primary" style={{ marginTop: 10 }} disabled={busy} onClick={() => setStatus(o.flow[idx + 1])}>Move to {o.flow[idx + 1]}</button>}
      </section>
      <div className="dash-cols" style={{ marginTop: 14 }}>
        <section className="panel"><h2>Details</h2>
          <div className="grid2">
            <Field label="Deadline"><input className="in" type="date" disabled={!edit} defaultValue={o.deadline || ''} onChange={e => run(() => patch(`/orders/${id}`, { deadline: e.target.value || null }), 'Deadline saved')} /></Field>
            <Field label="Payment"><select className="in" disabled={!edit} value={o.payment_status} onChange={e => run(() => patch(`/orders/${id}`, { payment_status: e.target.value }), 'Payment updated').then(reload)}>
              <option value="unpaid">Not paid</option><option value="deposit">Deposit received</option><option value="paid">Paid in full</option><option value="refunded">Refunded</option></select></Field>
            <Field label="Amount received ($)"><input className="in" type="number" step="0.01" disabled={!edit} defaultValue={o.amount_paid} onBlur={e => Number(e.target.value) !== o.amount_paid && run(() => patch(`/orders/${id}`, { amount_paid: Number(e.target.value) }), 'Saved')} /></Field>
            <div><span className="muted small">Total</span><div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{money(o.total)}</div><div className="small muted">Balance {money(o.total - o.amount_paid)}</div></div>
          </div>
          <h3 style={{ margin: '14px 0 6px' }}>Items</h3>
          <ul className="list">{o.items.map(i => <li key={i.id} className="row" style={{ padding: '6px 0' }}><span style={{ flex: 1 }}>{i.qty} × {i.description}{i.color ? ` — ${i.color}` : ''}{i.sizes ? ` (${i.sizes})` : ''}</span><span>{money(i.line_total)}</span></li>)}</ul>
        </section>
        <section className="panel"><h2>Design versions</h2>
          {o.designs.length === 0 && <p className="muted">No design versions yet.</p>}
          <ul className="list">{o.designs.map(d => <li key={d.id} style={{ padding: '8px 0' }}><div className="row"><b>Version {d.version}</b>{d.file_id && <a href={`/api/files/${d.file_id}`} target="_blank" rel="noreferrer">{d.filename}</a>}<span className="spacer" />
            {d.customer_approved_at ? <Pill tone="green">Approved {dateShort(d.customer_approved_at)}</Pill> : edit && <button className="btn small" onClick={() => setApprove(d)}>Record approval</button>}</div>
            {d.approval_note && <div className="small muted">{d.approval_note}</div>}</li>)}</ul>
          {edit && <label className="btn" style={{ marginTop: 8 }}><Icon name="clip" />Add design version<input type="file" hidden onChange={upload} accept="image/*,.pdf,.ai,.eps,.svg,.psd" /></label>}
          {o.files.length > 0 && <><h3 style={{ margin: '14px 0 6px' }}>Customer files</h3><ul className="list">{o.files.map(f => <li key={f.id}><a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer"><Pill>{f.kind}</Pill>{f.filename}</a></li>)}</ul></>}
        </section>
        <section className="panel"><h2>Production notes</h2>
          <textarea className="in" rows={6} disabled={!edit} value={notes ?? o.production_notes ?? ''} onChange={e => setNotes(e.target.value)} placeholder="Thread colors, placement, garment brand…" />
          {edit && notes !== null && <button className="btn" style={{ marginTop: 8 }} onClick={() => run(() => patch(`/orders/${id}`, { production_notes: notes }), 'Notes saved').then(() => { setNotes(null); reload(); })}>Save notes</button>}
          <div className="row" style={{ margin: '14px 0 6px' }}><h3>Tasks</h3><span className="spacer" />{can('tasks.write') && <button className="btn small" onClick={() => setTaskOpen(true)}>Add task</button>}</div>
          <TaskList tasks={o.tasks} reload={reload} />
        </section>
      </div>
      {approve && <ApproveDesign d={approve} orderId={id} onClose={() => { setApprove(null); reload(); }} />}
      {taskOpen && <TaskDialog contactId={o.contact_id} orderId={o.id} onClose={() => setTaskOpen(false)} onSaved={reload} />}
    </>
  );
}

function ApproveDesign({ d, orderId, onClose }) {
  const [note, setNote] = useState('');
  const [run, busy] = useAction();
  return <Modal title={`Customer approved version ${d.version}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || note.length < 3} onClick={() => run(() => post(`/orders/${orderId}/designs/${d.id}/approve`, { note }), 'Approval recorded').then(onClose)}>Record approval</button></>}>
    <Field label="How did the customer approve it?" hint='For example: "SMS reply: looks great" or "Approved in person at pickup".'><input className="in" value={note} onChange={e => setNote(e.target.value)} autoFocus /></Field>
  </Modal>;
}
