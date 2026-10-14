import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { SessionProvider, useSession } from './lib/session.jsx';
import { ToastProvider, Field } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import { post } from './lib/api.js';
import Dashboard from './pages/Dashboard.jsx';
import Customers from './pages/Customers.jsx';
import CustomerCard from './pages/CustomerCard.jsx';
import Inbox from './pages/Inbox.jsx';
import Calls from './pages/Calls.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Quotes, { QuoteEditor, PriceList } from './pages/Quotes.jsx';
import Orders, { OrderDetail } from './pages/Orders.jsx';
import Marketing, { CampaignDetail } from './pages/Marketing.jsx';
import Tasks from './pages/Tasks.jsx';
import Reports from './pages/Reports.jsx';
import Agents from './pages/Agents.jsx';
import Settings from './pages/Settings.jsx';
import PhoneTexts from './pages/PhoneTexts.jsx';

function Login() {
  const { reload } = useSession();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form className="panel" onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(null); try { await post('/auth/login', f); await reload(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
        <div className="brand" style={{ padding: 0 }}><span className="mark">DS</span><span>DS Systems CRM</span></div>
        <Field label="Email"><input className="in" type="email" autoComplete="username" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required autoFocus /></Field>
        <Field label="Password"><input className="in" type="password" autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required /></Field>
        {err && <div className="notice bad" role="alert">{err.message}{err.hint && <div className="small">{err.hint}</div>}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function App() {
  const { me } = useSession();
  if (me === undefined) return <div className="empty">Loading…</div>;
  if (!me) return <Routes><Route path="*" element={<Login />} /></Routes>;
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id" element={<CustomerCard />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:id" element={<Inbox />} />
        <Route path="calls" element={<Calls />} />
        <Route path="phone-texts" element={<PhoneTexts />} />
        <Route path="phone-texts/:id" element={<PhoneTexts />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="quotes" element={<Quotes />} />
        <Route path="quotes/price-list" element={<PriceList />} />
        <Route path="quotes/:id" element={<QuoteEditor />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="marketing" element={<Marketing />} />
        <Route path="marketing/:id" element={<CampaignDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="reports" element={<Reports />} />
        <Route path="agents" element={<Agents />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/:tab" element={<Settings />} />
        <Route path="*" element={<div className="empty"><h3>Page not found</h3><a href="/">Go to the dashboard</a></div>} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode><BrowserRouter><ToastProvider><SessionProvider><App /></SessionProvider></ToastProvider></BrowserRouter></StrictMode>
);
