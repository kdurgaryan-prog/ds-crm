import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useLoad, LoadError, Pill } from '../components/ui.jsx';
import { money } from '../lib/format.js';
import { KINDS } from './Marketing.jsx';

function Bars({ rows, value = 'n', won, label = 'k', link }) {
  const max = Math.max(1, ...rows.map(r => r[value]));
  if (!rows.length) return <p className="muted">No data in this period.</p>;
  return <div className="bars">{rows.map(r => <div key={r[label]} className="bar">
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r[label]}>{link ? <Link to={link(r)}>{r[label]}</Link> : r[label]}</span>
    <span className="track" style={{ position: 'relative' }}><span className="fill" style={{ width: `${(r[value] / max) * 100}%`, display: 'block' }} />
      {won && <span className="fill won" style={{ width: `${(r[won] / max) * 100}%`, display: 'block', position: 'absolute', top: 0, left: 0 }} />}</span>
    <span style={{ textAlign: 'right' }}>{r[value]}{won ? <span className="muted small"> / {r[won]}</span> : null}</span></div>)}</div>;
}

export default function Reports() {
  const [days, setDays] = useState(30);
  const { data: d, error, reload } = useLoad(() => get(`/reports?days=${days}`), [days]);
  return (
    <>
      <div className="page-head"><h1>Reports</h1>
        <div className="seg">{[7, 30, 90, 365].map(n => <button key={n} className={days === n ? 'on' : ''} onClick={() => setDays(n)}>{n === 365 ? 'Year' : `${n} days`}</button>)}</div></div>
      <LoadError error={error} retry={reload} />
      {d && <div className="dash-cols">
        <section className="panel"><h2>Leads by source</h2><p className="small muted" style={{ marginTop: -6 }}>Blue: all leads · Green: won</p><Bars rows={d.leadsBySource} value="leads" won="won" link={r => `/customers?source=${encodeURIComponent(r.k)}`} /></section>
        <section className="panel"><h2>Pipeline now</h2><Bars rows={['New', 'Contacted', 'Waiting', 'Qualified', 'Quote Sent', 'Won', 'Lost'].map(s => d.pipeline.find(p => p.k === s) || { k: s, n: 0 })} link={r => `/customers?status=${encodeURIComponent(r.k)}`} /></section>
        <section className="panel"><h2>Industries</h2><Bars rows={d.byIndustry} won="won" /></section>
        <section className="panel"><h2>Products asked for</h2><Bars rows={d.byProduct} /></section>
        <section className="panel"><h2>Quotes and orders</h2>
          <dl className="kv"><dt>Quotes created</dt><dd>{d.quotes.created}</dd><dt>Sent to customers</dt><dd>{d.quotes.sent}</dd><dt>Accepted</dt><dd>{d.quotes.accepted} ({money(d.quotes.accepted_value)})</dd>
            <dt>Win rate</dt><dd>{d.quotes.sent ? Math.round((d.quotes.accepted / d.quotes.sent) * 100) + '%' : '—'}</dd></dl>
          <h3 style={{ margin: '12px 0 6px' }}>Orders by stage</h3><Bars rows={d.orders} /></section>
        <section className="panel"><h2>Calls and replies</h2>
          <dl className="kv"><dt>Calls</dt><dd>{d.calls.total}</dd><dt>Answered by AI</dt><dd>{d.calls.ai}</dd><dt>Missed</dt><dd>{d.calls.missed}</dd>
            <dt>Average length</dt><dd>{d.calls.avg_sec ? `${Math.floor(d.calls.avg_sec / 60)}m ${d.calls.avg_sec % 60}s` : '—'}</dd>
            <dt>Typical reply time</dt><dd>{d.responseTime?.median_min !== null && d.responseTime?.median_min !== undefined ? `${Math.round(d.responseTime.median_min)} min` : '—'}</dd></dl></section>
        <section className="panel" style={{ gridColumn: '1 / -1' }}><h2>Campaigns</h2>
          {d.campaigns.length === 0 ? <p className="muted">No campaigns in this period.</p> :
            <ul className="list">{d.campaigns.map(c => <li key={c.id}><Link to={`/marketing/${c.id}`}><span style={{ flex: 1 }}>{c.title}</span><Pill>{KINDS[c.kind]}</Pill><span className="small">{c.reached} reached · {c.skipped} skipped · {c.replies} replied</span></Link></li>)}</ul>}</section>
      </div>}
    </>
  );
}
