import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useLoad, LoadError, Pill } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { CHANNEL, ago, dateShort, dateTime, daysUntil, leadName } from '../lib/format.js';

const TAGS = [
  { key: 'unanswered', label: 'Unanswered messages', to: '/inbox?needs_reply=1', hot: true },
  { key: 'missed_calls', label: 'Missed calls', sub: 'last 7 days', to: '/calls?filter=missed', hot: true },
  { key: 'callbacks', label: 'Callbacks due today', to: '/tasks?view=callbacks', hot: true },
  { key: 'overdue_tasks', label: 'Overdue tasks', to: '/tasks?view=overdue', hot: true },
  { key: 'quotes_pending', label: 'Quotes to finish or approve', to: '/quotes?status=draft,pending_approval' },
  { key: 'orders_due_soon', label: 'Orders due within 7 days', to: '/orders?due=week', hot: true },
  { key: 'new_leads', label: 'New leads not contacted', to: '/customers?status=New' },
  { key: 'approvals', label: 'Marketing waiting for approval', to: '/marketing?status=pending_approval' },
];

export default function Dashboard() {
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => get('/dashboard'), []);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <div className="empty">Loading today…</div>;
  const c = data.counts;
  const problems = [
    c.failed_messages > 0 && { to: '/inbox', text: `${c.failed_messages} message${c.failed_messages > 1 ? 's were' : ' was'} not delivered. Open the conversation to see why.` },
    c.failed_actions > 0 && me.permissions.includes('jobs.manage') && { to: '/settings/failed', text: `${c.failed_actions} automatic action${c.failed_actions > 1 ? 's' : ''} failed and need${c.failed_actions > 1 ? '' : 's'} attention.` },
    c.duplicates > 0 && { to: '/customers?tab=duplicates', text: `${c.duplicates} possible duplicate customer${c.duplicates > 1 ? 's' : ''} to review.` },
  ].filter(Boolean);
  const notConnected = data.channels.filter(ch => ch.status === 'error');
  return (
    <>
      <div className="page-head"><h1>{greet}, {me.user.name.split(' ')[0]}</h1><span className="muted">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>
      <div className="tags">
        {TAGS.map(t => {
          const n = c[t.key] || 0;
          return <Link key={t.key} to={t.to} className={`tag${t.hot && n > 0 ? ' hot' : ''}${n === 0 ? ' zero' : ''}`}>
            <div className="n">{n}</div><div className="l">{t.label}</div>{t.sub && <div className="s">{t.sub}</div>}</Link>;
        })}
      </div>
      {(problems.length > 0 || notConnected.length > 0) && <div className="panel" style={{ marginBottom: 14 }}>
        <h2>Needs a look</h2>
        <ul className="list links">{problems.map(p => <li key={p.to}><Link to={p.to}>{p.text}</Link></li>)}
          {notConnected.map(ch => <li key={ch.channel}><Link to="/settings/channels">{CHANNEL[ch.channel] || ch.channel} has a connection problem: {ch.last_error}</Link></li>)}</ul>
      </div>}
      <div className="dash-cols">
        <section className="panel">
          <h2>Waiting for a reply</h2>
          {data.lists.unanswered.length === 0 ? <p className="muted">Everyone has an answer.</p> :
            <ul className="list">{data.lists.unanswered.map(u => <li key={u.id}><Link to={`/inbox/${u.id}`}><Pill tone="blue">{CHANNEL[u.channel]}</Pill><span style={{ flex: 1 }}>{leadName(u)}</span><span className="muted small">{ago(u.last_message_at)}</span></Link></li>)}</ul>}
        </section>
        <section className="panel">
          <h2>Today's tasks</h2>
          {data.lists.tasks.length === 0 ? <p className="muted">No tasks due today.</p> :
            <ul className="list">{data.lists.tasks.map(t => <li key={t.id}><Link to={t.contact_id ? `/customers/${t.contact_id}` : '/tasks'}>
              {t.kind === 'callback' ? <Pill tone="amber">Call back</Pill> : t.kind === 'handoff' ? <Pill tone="amber">Handoff</Pill> : null}
              <span style={{ flex: 1 }}>{t.title}{t.name ? <span className="muted"> — {t.name}</span> : null}</span>
              <span className={`small ${t.due_at && new Date(t.due_at) < new Date() ? '' : 'muted'}`} style={t.due_at && new Date(t.due_at) < new Date() ? { color: 'var(--red)' } : null}>{t.due_at ? dateTime(t.due_at) : 'No time'}</span></Link></li>)}</ul>}
        </section>
        <section className="panel">
          <h2>Order deadlines this week</h2>
          {data.lists.orders.length === 0 ? <p className="muted">No orders due in the next 7 days.</p> :
            <ul className="list">{data.lists.orders.map(o => { const d = daysUntil(o.deadline); return <li key={o.id}><Link to={`/orders/${o.id}`}>
              <b>#{o.order_no}</b><span style={{ flex: 1 }}>{o.company || o.name}<br /><span className="muted small">{o.status}</span></span>
              <Pill tone={d < 0 ? 'red' : d <= 2 ? 'amber' : ''}>{d < 0 ? `${-d}d late` : d === 0 ? 'Today' : dateShort(o.deadline)}</Pill></Link></li>; })}</ul>}
        </section>
      </div>
    </>
  );
}
