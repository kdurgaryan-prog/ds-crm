import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, qs } from '../lib/api.js';
import { useLoad, LoadError, Icon } from '../components/ui.jsx';
import { TaskList, TaskDialog } from './CustomerCard.jsx';
import { useSession } from '../lib/session.jsx';

export default function Tasks() {
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') || 'today';
  const mode = sp.get('mode') || 'list';
  const { can } = useSession();
  const [adding, setAdding] = useState(false);
  const users = useLoad(() => get('/contacts/facets'), []);
  return (
    <>
      <div className="page-head"><h1>Tasks &amp; Calendar</h1>
        <div className="seg"><button className={mode === 'list' ? 'on' : ''} onClick={() => setSp({ view })}>List</button><button className={mode === 'cal' ? 'on' : ''} onClick={() => setSp({ view, mode: 'cal' })}>Calendar</button></div>
        {can('tasks.write') && <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />Add task</button>}
      </div>
      {mode === 'cal' ? <Calendar /> : <TaskView view={view} setView={v => setSp({ view: v })} adding={adding} />}
      {adding && <TaskDialog users={users.data?.users || []} onClose={() => setAdding(false)} onSaved={() => setSp({ view, r: Date.now() })} />}
    </>
  );
}

function TaskView({ view, setView }) {
  const [sp] = useSearchParams();
  const { data, error, reload } = useLoad(() => get(`/tasks${qs({ view })}`), [view, sp.get('r')]);
  return (
    <>
      <div className="tabs">{[['today', 'Due today'], ['overdue', 'Overdue'], ['callbacks', 'Callbacks'], ['open', 'All open'], ['done', 'Done']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>
      <LoadError error={error} retry={reload} />
      {data && <div className="panel">{data.length === 0 ? <p className="muted">Nothing here.</p> :
        <TaskList tasks={data.map(t => ({ ...t, title: <>{t.title}{t.contact_id && <> — <Link to={`/customers/${t.contact_id}`}>{t.contact_name || t.company || `Lead ${t.lead_no}`}</Link></>}{t.assignee_name && <span className="muted small"> ({t.assignee_name})</span>}</> }))} reload={reload} />}</div>}
    </>
  );
}

function Calendar() {
  const nav = useNavigate();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const start = new Date(month); start.setDate(1 - ((month.getDay() + 6) % 7)); // Monday first
  const end = new Date(start); end.setDate(start.getDate() + 42);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const { data, error } = useLoad(() => get(`/tasks/calendar${qs({ from: start.toISOString(), to: end.toISOString() })}`), [month.getTime()]);
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = iso(new Date());
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn small" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>Previous</button>
        <h2 style={{ minWidth: 180, textAlign: 'center' }}>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
        <button className="btn small" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>Next</button>
        <button className="btn small" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
        <span className="spacer" /><span className="small muted">Blue: tasks · Green: order deadlines</span>
      </div>
      <LoadError error={error} />
      <div className="cal" role="grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="dh">{d}</div>)}
        {days.map(d => {
          const k = iso(d);
          const tasks = (data?.tasks || []).filter(t => iso(new Date(t.due_at)) === k);
          const orders = (data?.orders || []).filter(o => o.deadline === k);
          return <div key={k} className={`day${d.getMonth() !== month.getMonth() ? ' out' : ''}${k === today ? ' today' : ''}`}>
            <span className="dn">{d.getDate()}</span>
            {orders.map(o => <button key={o.id} className="ev order" onClick={() => nav(`/orders/${o.id}`)} title={`Order #${o.order_no} — ${o.company || o.contact_name}`}>#{o.order_no} {o.company || o.contact_name}</button>)}
            {tasks.map(t => <button key={t.id} className={`ev${!t.done_at && new Date(t.due_at) < new Date() ? ' late' : ''}`} style={t.done_at ? { textDecoration: 'line-through', opacity: .6 } : null} onClick={() => t.contact_id && nav(`/customers/${t.contact_id}`)} title={t.title}>{new Date(t.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} {t.title}</button>)}
          </div>;
        })}
      </div>
    </>
  );
}
