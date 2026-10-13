import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon, Modal, Field, useAction } from './ui.jsx';
import { useSession } from '../lib/session.jsx';
import { get, post, qs } from '../lib/api.js';
import { phone, leadName } from '../lib/format.js';
import Softphone, { useSoftphone } from './Softphone.jsx';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: 'home', end: true },
  { to: '/customers', label: 'Leads & Customers', icon: 'users', perm: 'contacts.read' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox', perm: 'inbox.read', count: 'unanswered' },
  { to: '/calls', label: 'Calls', icon: 'phone', perm: 'calls.read', count: 'missed_calls' },
  { to: '/pipeline', label: 'Sales Pipeline', icon: 'pipeline', perm: 'contacts.read' },
  { to: '/quotes', label: 'Quotes', icon: 'quote', perm: 'quotes.read' },
  { to: '/orders', label: 'Orders', icon: 'box', perm: 'orders.read' },
  { to: '/marketing', label: 'Marketing', icon: 'megaphone', perm: 'marketing.read', count: 'approvals' },
  { to: '/tasks', label: 'Tasks & Calendar', icon: 'calendar', perm: 'contacts.read', count: 'overdue_tasks' },
  { to: '/reports', label: 'Reports', icon: 'chart', perm: 'reports.read' },
  { to: '/agents', label: 'AI Agents', icon: 'spark', perm: 'agents.read' },
  { to: '/settings', label: 'Settings', icon: 'gear', perm: 'settings.read' },
];

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const nav = useNavigate();
  const box = useRef(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const ac = new AbortController();
    const t = setTimeout(() => get(`/contacts${qs({ q, size: 10 })}`, { signal: ac.signal }).then(r => { setRows(r.rows); setHl(0); }).catch(() => {}), 180);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q]);
  useEffect(() => {
    const k = e => { if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName)) { e.preventDefault(); box.current?.querySelector('input')?.focus(); } };
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k);
  }, []);
  const go = r => { setOpen(false); setQ(''); nav(`/customers/${r.id}`); };
  return (
    <div className="search" ref={box} onBlur={e => { if (!box.current.contains(e.relatedTarget)) setOpen(false); }}>
      <Icon name="search" />
      <input placeholder="Find a customer — name, company, phone or lead #" value={q} aria-label="Find a customer"
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHl(h => Math.min(h + 1, rows.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHl(h => Math.max(h - 1, 0)); }
          if (e.key === 'Enter' && rows[hl]) go(rows[hl]);
          if (e.key === 'Escape') setOpen(false);
        }} />
      {open && q.trim().length >= 2 && (
        <div className="results" role="listbox">
          {rows.length === 0 && <div className="muted" style={{ padding: 12 }}>No customer matches "{q}".</div>}
          {rows.map((r, i) => (
            <button key={r.id} className={i === hl ? 'hl' : ''} onMouseDown={e => e.preventDefault()} onClick={() => go(r)} role="option" aria-selected={i === hl}>
              <span className="muted nowrap">Lead {r.lead_no}</span>
              <span style={{ minWidth: 0 }}><b>{leadName(r)}</b>{r.company && r.name ? <span className="muted"> — {r.company}</span> : null}<br /><span className="muted small">{phone(r.phone_e164)} {r.status}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuickAdd({ onClose }) {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', company: '', phone: '', product_type: '', quantity: '', source: 'manual' });
  const [errs, setErrs] = useState({});
  const [run, busy] = useAction();
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const save = async e => {
    e.preventDefault();
    try {
      const r = await run(() => post('/contacts', { ...f, quantity: f.quantity || null }), r => (r.existing ? `Already in the CRM as Lead ${r.contact.lead_no} — opened it` : `Lead ${r.contact.lead_no} created`));
      onClose(); nav(`/customers/${r.contact.id}`);
    } catch (err) { setErrs(err.fieldErrors?.() || {}); }
  };
  return (
    <Modal title="New lead" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="quickadd" disabled={busy}>Save lead</button></>}>
      <form id="quickadd" onSubmit={save} className="grid2">
        <Field label="Name" error={errs.name}><input className="in" value={f.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Company" error={errs.company}><input className="in" value={f.company} onChange={set('company')} /></Field>
        <Field label="Phone" error={errs.phone} hint="We check this number for duplicates."><input className={`in${errs.phone ? ' bad' : ''}`} type="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Product"><input className="in" value={f.product_type} onChange={set('product_type')} placeholder="e.g. Polos" /></Field>
        <Field label="Quantity" error={errs.quantity}><input className="in" type="number" min="0" value={f.quantity} onChange={set('quantity')} /></Field>
        <Field label="Source"><select className="in" value={f.source} onChange={set('source')}>{['manual', 'call', 'walk-in', 'referral', 'website_quote', 'instagram', 'messenger', 'sms', 'whatsapp', 'event'].map(s => <option key={s}>{s}</option>)}</select></Field>
      </form>
    </Modal>
  );
}

export default function Layout() {
  const { me, can } = useSession();
  const [counts, setCounts] = useState({});
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const loc = useLocation();
  const sp = useSoftphone();
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => {
    let alive = true;
    const tick = () => get('/dashboard').then(d => alive && setCounts(d.counts)).catch(() => {});
    tick(); const t = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [loc.pathname]);
  const items = NAV.filter(n => !n.perm || can(n.perm));
  const mobile = items.filter(n => ['/', '/customers', '/inbox', '/calls'].includes(n.to));
  return (
    <div className="shell">
      <nav className={`nav${menu ? ' open' : ''}`} aria-label="Main">
        <div className="brand"><span className="mark">DS</span><span>DS Systems</span></div>
        {items.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} /><span>{n.label}</span>{n.count && counts[n.count] > 0 && <span className="count">{counts[n.count]}</span>}</NavLink>
        ))}
        <div className="foot"><div><b>{me.user.name}</b></div><div className="muted">{me.user.role[0].toUpperCase() + me.user.role.slice(1)} · {me.business.name}</div>
          <button className="btn small" style={{ marginTop: 8 }} onClick={async () => { await post('/auth/logout'); location.href = '/login'; }}>Sign out</button></div>
      </nav>
      {menu && <div className="modal-bg" style={{ zIndex: 140 }} onClick={() => setMenu(false)} />}
      <div className="main">
        {me.appEnv !== 'production' && <div className="env-banner">{me.appEnv === 'staging' ? 'Staging' : 'Test environment'} — messages, calls and posts are recorded but not delivered.</div>}
        <header className="topbar">
          <button className="btn ghost show-sm" aria-label="Menu" onClick={() => setMenu(true)}><Icon name="menu" /></button>
          <GlobalSearch />
          {can('contacts.write') && <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" /><span className="hide-sm">New lead</span></button>}
          {can('calls.make') && <button className="btn" onClick={() => sp.open()} aria-label="Phone"><Icon name="phone" /><span className="hide-sm">Phone</span></button>}
        </header>
        <main className="content" id="main"><Outlet /></main>
      </div>
      <nav className="mnav" aria-label="Quick">
        {mobile.map(n => <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} />{n.label.split(' ')[0]}{n.count && counts[n.count] > 0 && <span className="count">{counts[n.count]}</span>}</NavLink>)}
        <button onClick={() => setMenu(true)}><Icon name="menu" />More</button>
      </nav>
      {adding && <QuickAdd onClose={() => setAdding(false)} />}
      <Softphone />
    </div>
  );
}
