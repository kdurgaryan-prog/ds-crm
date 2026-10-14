import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { get, post, qs, api } from '../lib/api.js';
import { useLoad, LoadError, Pill, Field, Icon, useAction, Modal, Empty } from '../components/ui.jsx';
import DataTable, { useTableView, ViewBar } from '../components/DataTable.jsx';
import { phone, dateShort, ago, STATUS_TONE, leadName } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { NewPhoneList } from './PhoneTexts.jsx';

const FILTER_KEYS = ['q', 'status', 'source', 'owner', 'product', 'created_from', 'created_to', 'activity_from', 'activity_to', 'qty_min', 'qty_max', 'deadline_from', 'deadline_to'];

export default function Customers() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'list';
  return (
    <>
      <div className="page-head"><h1>Leads &amp; Customers</h1></div>
      <div className="tabs" role="tablist">
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setSp({})}>All customers</button>
        <button className={tab === 'duplicates' ? 'on' : ''} onClick={() => setSp({ tab: 'duplicates' })}>Possible duplicates</button>
      </div>
      {tab === 'duplicates' ? <Duplicates /> : <CustomerList />}
    </>
  );
}

function CustomerList() {
  const nav = useNavigate();
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map(k => [k, sp.get(k) || '']));
  const [sort, setSort] = useState(sp.get('sort') || 'last_activity_at');
  const [dir, setDir] = useState(sp.get('dir') || 'desc');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(FILTER_KEYS.some(k => k !== 'q' && sp.get(k)));
  const [importing, setImporting] = useState(false);
  const [phoneList, setPhoneList] = useState(false);
  const facets = useLoad(() => get('/contacts/facets'), []);
  const custom = facets.data?.customFields || [];
  const columns = useMemo(() => [
    { key: 'lead_no', label: 'Lead', width: 90, render: r => <b>Lead {r.lead_no}</b> },
    { key: 'name', label: 'Name', width: 170, render: r => r.name || <span className="muted">—</span> },
    { key: 'company', label: 'Company', width: 190 },
    { key: 'phone', label: 'Phone', width: 140, sortable: false, render: r => <span className="nowrap">{phone(r.phone_e164)}{r.dnc ? <> <Pill tone="red">DNC</Pill></> : r.opted_out_at ? <> <Pill tone="red">Opted out</Pill></> : null}</span> },
    { key: 'status', label: 'Status', width: 120, render: r => <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill> },
    { key: 'source', label: 'Source', width: 120 },
    { key: 'owner', label: 'Responsible', width: 140, sortable: false, render: r => r.owner_name || <span className="muted">Unassigned</span> },
    { key: 'product_type', label: 'Product', width: 130 },
    { key: 'quantity', label: 'Quantity', width: 90 },
    { key: 'decoration', label: 'Print or embroidery', width: 150, sortable: false },
    { key: 'deadline', label: 'Deadline', width: 110, render: r => dateShort(r.deadline) },
    { key: 'colors', label: 'Colors', width: 140, sortable: false, hidden: true },
    { key: 'sizes', label: 'Sizes', width: 140, sortable: false, hidden: true },
    { key: 'industry', label: 'Industry', width: 130, sortable: false, hidden: true },
    { key: 'email', label: 'Email', width: 200, sortable: false, hidden: true },
    { key: 'created_at', label: 'Created', width: 110, render: r => dateShort(r.created_at) },
    { key: 'last_activity_at', label: 'Last activity', width: 120, render: r => ago(r.last_activity_at) },
    ...custom.map(f => ({ key: `cf_${f.key}`, label: f.label, width: 140, sortable: false, hidden: true, render: r => { const v = r.custom?.[f.key]; return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v; } })),
  ], [custom]);
  const view = useTableView('contacts', columns);
  const query = { ...filters, sort, dir, page, size: 50 };
  const { data, error, loading, reload } = useLoad(() => get(`/contacts${qs(query)}`), [JSON.stringify(query)]);
  useEffect(() => setPage(1), [JSON.stringify(filters)]); // eslint-disable-line
  const setFilter = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const active = FILTER_KEYS.filter(k => filters[k]).length;
  const f = facets.data;
  return (
    <>
      <div className="table-tools">
        <input className="in" style={{ maxWidth: 280 }} placeholder="Search this list" value={filters.q} onChange={e => setFilter('q', e.target.value)} aria-label="Search customers" />
        <button className="btn" onClick={() => setShowFilters(s => !s)} aria-expanded={showFilters}><Icon name="filter" />Filters{active ? ` (${active})` : ''}</button>
        {active > 0 && <button className="btn" onClick={() => setSp({}, { replace: true })}>Clear filters</button>}
        <ViewBar view={view} columns={columns} />
        <span className="spacer" />
        {can('inbox.reply') && <button className="btn" disabled={!data?.total} onClick={() => setPhoneList(true)}><Icon name="send" />Text from my phone</button>}
        {can('contacts.import') && <button className="btn" onClick={() => setImporting(true)}>Import</button>}
        {can('contacts.export') && <a className="btn" href={`/api/contacts/export.csv${qs({ ...filters, sort, dir })}`}><Icon name="download" />Export</a>}
      </div>
      {showFilters && f && (
        <div className="filters">
          <Field label="Status"><select className="in" value={filters.status} onChange={e => setFilter('status', e.target.value)}><option value="">Any</option>{f.statuses.map(s => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Source"><select className="in" value={filters.source} onChange={e => setFilter('source', e.target.value)}><option value="">Any</option>{f.sources.map(s => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Responsible"><select className="in" value={filters.owner} onChange={e => setFilter('owner', e.target.value)}><option value="">Anyone</option><option value="none">Unassigned</option>{f.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <Field label="Product"><select className="in" value={filters.product} onChange={e => setFilter('product', e.target.value)}><option value="">Any</option>{f.products.map(s => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Quantity from"><input className="in" type="number" value={filters.qty_min} onChange={e => setFilter('qty_min', e.target.value)} style={{ width: 100 }} /></Field>
          <Field label="to"><input className="in" type="number" value={filters.qty_max} onChange={e => setFilter('qty_max', e.target.value)} style={{ width: 100 }} /></Field>
          <Field label="Created from"><input className="in" type="date" value={filters.created_from} onChange={e => setFilter('created_from', e.target.value)} /></Field>
          <Field label="Created to"><input className="in" type="date" value={filters.created_to} onChange={e => setFilter('created_to', e.target.value)} /></Field>
          <Field label="Last activity from"><input className="in" type="date" value={filters.activity_from} onChange={e => setFilter('activity_from', e.target.value)} /></Field>
          <Field label="Last activity to"><input className="in" type="date" value={filters.activity_to} onChange={e => setFilter('activity_to', e.target.value)} /></Field>
          <Field label="Deadline from"><input className="in" type="date" value={filters.deadline_from} onChange={e => setFilter('deadline_from', e.target.value)} /></Field>
          <Field label="Deadline to"><input className="in" type="date" value={filters.deadline_to} onChange={e => setFilter('deadline_to', e.target.value)} /></Field>
          <button className="btn" onClick={() => setSp({}, { replace: true })} disabled={!active}>Clear filters</button>
        </div>
      )}
      <LoadError error={error} retry={reload} />
      {data && <>
        <DataTable columns={columns} rows={data.rows.map(r => ({ ...r, ...Object.fromEntries(Object.entries(r.custom || {}).map(([k, v]) => [`cf_${k}`, v])) }))} view={view} sort={sort} dir={dir} offset={showFilters ? 420 : 270}
          onSort={k => { if (k === sort) setDir(d => (d === 'asc' ? 'desc' : 'asc')); else { setSort(k); setDir('asc'); } }}
          onRowClick={r => nav(`/customers/${r.id}`)}
          empty={<Empty title={active ? 'No customers match these filters' : 'No customers yet'} action={active ? <button className="btn" onClick={() => setSp({})}>Clear filters</button> : null}>{active ? 'Try removing a filter.' : 'New leads from calls, messages and your website appear here automatically.'}</Empty>} />
        <div className="pager"><span className="muted">{data.total.toLocaleString()} customers{loading ? ' · updating…' : ''}</span>
          <button className="btn small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span>Page {data.page} of {Math.max(1, data.pages)}</span>
          <button className="btn small" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>Next</button></div>
      </>}
      {phoneList && <NewPhoneList filters={filters} count={data?.total} defaultName={filters.source || filters.q || ''} onClose={() => setPhoneList(false)} />}
      {importing && <ImportDialog onClose={() => { setImporting(false); reload(); }} />}
    </>
  );
}

function ImportDialog({ onClose }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [run, busy] = useAction();
  const send = commit => { const fd = new FormData(); fd.append('file', file); return api(`/contacts/import${commit ? '?commit=1' : ''}`, { method: 'POST', form: fd }); };
  return (
    <Modal title="Import customers from CSV" onClose={onClose} footer={done ? <button className="btn primary" onClick={onClose}>Done</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      {!preview ? <button className="btn primary" disabled={!file || busy} onClick={() => run(() => send(false)).then(setPreview)}>Check file</button>
        : <button className="btn primary" disabled={busy} onClick={() => run(() => send(true), r => `Imported: ${r.created} new, ${r.updated} updated`).then(setDone)}>Import {preview.created + preview.updated} rows</button>}</>}>
      <p className="muted" style={{ margin: 0 }}>Columns we read: name, company, phone, email, source, product, quantity, decoration, industry, notes. Existing phone numbers update the existing customer — nothing is merged by name.</p>
      <input type="file" accept=".csv,text/csv" onChange={e => { setFile(e.target.files[0]); setPreview(null); }} />
      {preview && !done && <div className="notice"><b>{preview.total}</b> rows: {preview.created} new, {preview.updated} existing to update, {preview.invalid.length} with problems.
        {preview.invalid.slice(0, 8).map(i => <div key={i.row} className="small">Row {i.row}: {i.reason}</div>)}</div>}
      {done && <div className="notice good">Imported {done.created} new and updated {done.updated}. {done.duplicatesFlagged > 0 && `${done.duplicatesFlagged} possible duplicates are waiting for review.`}</div>}
    </Modal>
  );
}

function Duplicates() {
  const { data, error, reload } = useLoad(() => get('/contacts/duplicates'), []);
  const [run, busy] = useAction();
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <div className="empty">Loading…</div>;
  if (!data.length) return <Empty title="No possible duplicates">We flag records with the same name or company but different phone numbers, so a person can decide.</Empty>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>These look similar but have different phone numbers or IDs, so they were not merged automatically.</p>
      {data.map(d => (
        <div key={d.id} className="panel">
          <div className="row" style={{ marginBottom: 8 }}><b>{d.reason}</b></div>
          <div className="grid2">{[d.a, d.b].map(x => <div key={x.id} className="notice"><Link to={`/customers/${x.id}`}><b>Lead {x.lead_no}</b> {leadName(x)}</Link><br />{x.company}<br />{phone(x.phone_e164)} {x.email}<br /><span className="muted small">From {x.source || 'unknown'}, {dateShort(x.created_at)}</span></div>)}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy} onClick={() => run(() => post('/contacts/merge', { into: d.a.lead_no < d.b.lead_no ? d.a.id : d.b.id, from: d.a.lead_no < d.b.lead_no ? d.b.id : d.a.id }), 'Merged into the older record').then(reload)}>Same person — merge into Lead {Math.min(d.a.lead_no, d.b.lead_no)}</button>
            <button className="btn" disabled={busy} onClick={() => run(() => post(`/contacts/duplicates/${d.id}/dismiss`), 'Kept as separate customers').then(reload)}>Different people</button>
          </div>
        </div>
      ))}
    </div>
  );
}
