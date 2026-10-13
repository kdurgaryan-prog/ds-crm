import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post, del, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, Field, useAction, Empty, Icon, Confirm } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { money, dateShort, leadName } from '../lib/format.js';

const Q_TONE = { draft: '', pending_approval: 'amber', approved: 'blue', sent: 'blue', accepted: 'green', declined: 'red', expired: 'red' };
const Q_LABEL = { draft: 'Draft', pending_approval: 'Needs approval', approved: 'Approved', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', expired: 'Expired' };

export default function Quotes() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const status = sp.get('status') || '';
  const { data, error, reload } = useLoad(() => get(`/quotes${qs({ status })}`), [status]);
  return (
    <>
      <div className="page-head"><h1>Quotes</h1>
        <div className="seg">{[['', 'All'], ['draft,pending_approval', 'To finish'], ['approved,sent', 'Out with customer'], ['accepted', 'Accepted']].map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setSp(k ? { status: k } : {})}>{l}</button>)}</div>
        <Link className="btn" to="/quotes/price-list">Price list</Link>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>Start a quote from a customer's card. Drafts made by AI use only the approved price list and must be approved before sending.</p>
      <LoadError error={error} retry={reload} />
      {data && (data.length === 0 ? <Empty title="No quotes here">Open a customer and choose "New quote".</Empty> :
        <div className="tscroll" style={{ '--t-offset': '230px' }}><table className="dt" style={{ width: '100%' }}>
          <thead><tr><th style={{ width: 90 }}>Quote</th><th>Customer</th><th style={{ width: 150 }}>Status</th><th style={{ width: 120 }}>Total</th><th style={{ width: 120 }}>Created</th><th style={{ width: 120 }}>Valid until</th></tr></thead>
          <tbody>{data.map(q => <tr key={q.id} onClick={() => nav(`/quotes/${q.id}`)}>
            <td><b>Q-{q.quote_no}</b></td><td>{leadName({ name: q.contact_name, company: q.company, lead_no: q.lead_no })}{q.company && q.contact_name ? <span className="muted"> — {q.company}</span> : null}</td>
            <td><Pill tone={Q_TONE[q.status]}>{Q_LABEL[q.status]}</Pill>{q.created_by_agent && <> <Pill tone="amber">AI draft</Pill></>}</td>
            <td>{money(q.total)}</td><td>{dateShort(q.created_at)}</td><td>{dateShort(q.valid_until)}</td></tr>)}</tbody></table></div>)}
    </>
  );
}

export function QuoteEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const { data: q, error, reload } = useLoad(() => get(`/quotes/${id}`), [id]);
  const prices = useLoad(() => get('/price-list'), []);
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (q) { setItems(q.items.map(i => ({ sku: prices.data?.find(p => p.id === i.price_item_id)?.sku || '', description: i.description, decoration: i.decoration || '', color: i.color || '', sizes: i.sizes || '', qty: i.qty, unit_price: i.unit_price, custom: !i.price_item_id }))); setMeta({ tax_rate: q.tax_rate, shipping: q.shipping, production_days: q.production_days ?? '', due_date: q.due_date || '', notes: q.notes || '' }); } }, [q, prices.data]);
  if (error) return <LoadError error={error} retry={reload} />;
  if (!q || !items || !meta) return <div className="empty">Loading quote…</div>;
  const editable = can('quotes.write') && ['draft', 'pending_approval'].includes(q.status);
  const skus = [...new Map((prices.data || []).filter(p => p.active && p.approved_at).map(p => [p.sku, p])).values()];
  const tierPrice = (sku, qty) => (prices.data || []).filter(p => p.sku === sku && p.active && p.approved_at && p.min_qty <= qty).sort((a, b) => b.min_qty - a.min_qty)[0];
  const lines = items.map(i => { const t = !i.custom && i.sku ? tierPrice(i.sku, Number(i.qty) || 0) : null; const unit = i.custom ? Number(i.unit_price) || 0 : t ? Number(t.unit_price) : null; return { ...i, unit, total: unit !== null ? unit * (Number(i.qty) || 0) : null, missing: !i.custom && i.sku && !t }; });
  const subtotal = lines.reduce((s, l) => s + (l.total || 0), 0);
  const tax = Math.round(subtotal * Number(meta.tax_rate) * 100) / 100;
  const total = subtotal + tax + Number(meta.shipping || 0);
  const saveAll = () => run(() => patch(`/quotes/${id}`, { items: items.map(i => i.custom ? { description: i.description, decoration: i.decoration, color: i.color, sizes: i.sizes, qty: Number(i.qty), unit_price: Number(i.unit_price) } : { sku: i.sku, description: i.description, decoration: i.decoration, color: i.color, sizes: i.sizes, qty: Number(i.qty) }),
    tax_rate: Number(meta.tax_rate), shipping: Number(meta.shipping || 0), production_days: meta.production_days === '' ? null : Number(meta.production_days), due_date: meta.due_date || null, notes: meta.notes }), 'Quote saved').then(reload);
  const act = (a, msg) => run(() => post(`/quotes/${id}/${a}`), msg).then(reload);
  const setItem = (i, k, v) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <>
      <div className="page-head">
        <button className="btn ghost" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button>
        <h1>Quote Q-{q.quote_no}</h1><Pill tone={Q_TONE[q.status]}>{Q_LABEL[q.status]}</Pill>{q.created_by_agent && <Pill tone="amber">Drafted by AI from the price list</Pill>}
        <span className="spacer" />
        <a className="btn" href={`/api/quotes/${id}/print`} target="_blank" rel="noreferrer">Print / PDF</a>
      </div>
      <p>For <Link to={`/customers/${q.contact_id}`}><b>{leadName({ name: q.contact_name, company: q.company, lead_no: q.lead_no })}</b></Link>{q.company && q.contact_name ? ` — ${q.company}` : ''}</p>
      {q.status === 'pending_approval' && <div className="notice warn" style={{ marginBottom: 12 }}>Waiting for an owner or admin to approve the final prices before it can be sent.</div>}
      <section className="panel">
        <h2>Items</h2>
        <div style={{ overflowX: 'auto' }}><table className="dt" style={{ width: '100%', minWidth: 760 }}>
          <thead><tr><th style={{ width: 220 }}>Item</th><th>Description</th><th style={{ width: 110 }}>Color</th><th style={{ width: 140 }}>Sizes</th><th style={{ width: 80 }}>Qty</th><th style={{ width: 100 }}>Unit</th><th style={{ width: 100 }}>Total</th>{editable && <th style={{ width: 50 }}></th>}</tr></thead>
          <tbody>{lines.map((l, i) => <tr key={i} style={{ cursor: 'default' }}>
            <td>{editable ? <select className="in" value={l.custom ? '__custom' : l.sku} onChange={e => e.target.value === '__custom' ? setItems(items.map((x, j) => j === i ? { ...x, custom: true, sku: '' } : x)) : setItems(items.map((x, j) => j === i ? { ...x, custom: false, sku: e.target.value, description: skus.find(s => s.sku === e.target.value)?.name || x.description, decoration: skus.find(s => s.sku === e.target.value)?.decoration || '' } : x))}>
              <option value="">Choose…</option>{skus.map(s => <option key={s.sku} value={s.sku}>{s.name}</option>)}<option value="__custom">Custom price…</option></select> : (l.sku || 'Custom')}</td>
            <td>{editable ? <input className="in" value={l.description} onChange={e => setItem(i, 'description', e.target.value)} /> : l.description}</td>
            <td>{editable ? <input className="in" value={l.color} onChange={e => setItem(i, 'color', e.target.value)} /> : l.color}</td>
            <td>{editable ? <input className="in" value={l.sizes} onChange={e => setItem(i, 'sizes', e.target.value)} /> : l.sizes}</td>
            <td>{editable ? <input className="in" type="number" min="1" value={l.qty} onChange={e => setItem(i, 'qty', e.target.value)} /> : l.qty}</td>
            <td>{editable && l.custom ? <input className="in" type="number" min="0" step="0.01" value={l.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)} /> : l.missing ? <span style={{ color: 'var(--red)' }} className="small">No price at this qty</span> : money(l.unit)}</td>
            <td>{l.total !== null ? money(l.total) : '—'}</td>
            {editable && <td><button className="btn ghost small" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove line"><Icon name="x" /></button></td>}
          </tr>)}</tbody></table></div>
        {editable && <button className="btn small" style={{ marginTop: 8 }} onClick={() => setItems([...items, { sku: '', description: '', decoration: '', color: '', sizes: '', qty: 20, unit_price: 0, custom: false }])}><Icon name="plus" />Add line</button>}
        {lines.some(l => l.custom) && <div className="notice warn small" style={{ marginTop: 10 }}>Custom prices are not from the approved price list. An owner or admin must approve this quote.</div>}
        <div className="grid2" style={{ marginTop: 14 }}>
          <Field label="Tax rate (%)"><input className="in" type="number" step="0.01" disabled={!editable} value={(Number(meta.tax_rate) * 100).toFixed(2)} onChange={e => setMeta({ ...meta, tax_rate: Number(e.target.value) / 100 })} /></Field>
          <Field label="Shipping ($)"><input className="in" type="number" step="0.01" disabled={!editable} value={meta.shipping} onChange={e => setMeta({ ...meta, shipping: e.target.value })} /></Field>
          <Field label="Production time (business days)"><input className="in" type="number" disabled={!editable} value={meta.production_days} onChange={e => setMeta({ ...meta, production_days: e.target.value })} /></Field>
          <Field label="Needed by"><input className="in" type="date" disabled={!editable} value={meta.due_date} onChange={e => setMeta({ ...meta, due_date: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><textarea className="in" disabled={!editable} value={meta.notes} onChange={e => setMeta({ ...meta, notes: e.target.value })} /></Field>
        <dl className="kv" style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 14 }}>
          <dt>Subtotal</dt><dd style={{ textAlign: 'right' }}>{money(subtotal)}</dd><dt>Tax</dt><dd style={{ textAlign: 'right' }}>{money(tax)}</dd>
          <dt>Shipping</dt><dd style={{ textAlign: 'right' }}>{money(meta.shipping || 0)}</dd><dt><b>Total</b></dt><dd style={{ textAlign: 'right' }}><b>{money(total)}</b></dd></dl>
      </section>
      <div className="row" style={{ marginTop: 14 }}>
        {editable && <button className="btn" disabled={busy} onClick={saveAll}>Save changes</button>}
        {q.status === 'draft' && can('quotes.write') && <button className="btn" disabled={busy} onClick={() => saveAll().then(() => act('submit', 'Sent for approval'))}>Send for approval</button>}
        {['draft', 'pending_approval'].includes(q.status) && can('quotes.approve') && <button className="btn primary" disabled={busy || lines.some(l => l.missing)} onClick={() => saveAll().then(() => act('approve', 'Prices approved'))}>Approve prices</button>}
        {q.status === 'approved' && <button className="btn primary" onClick={() => setConfirm({ a: 'mark_sent', t: 'Mark as sent?', x: 'Use this after you have sent the printed quote or PDF to the customer. The customer moves to "Quote Sent".' })}>Mark as sent to customer</button>}
        {['approved', 'sent', 'accepted'].includes(q.status) && !q.order_id && can('orders.write') && <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/quotes/${id}/order`), r => `Order #${r.order.order_no} created`).then(r => nav(`/orders/${r.order.id}`))}><Icon name="box" />Create order</button>}
        {q.order_id && <Link className="btn" to={`/orders/${q.order_id}`}>Open order</Link>}
        {['approved', 'sent'].includes(q.status) && <button className="btn" onClick={() => act('decline', 'Marked declined')}>Customer declined</button>}
        {['declined', 'approved', 'pending_approval'].includes(q.status) && can('quotes.write') && <button className="btn ghost" onClick={() => act('reopen', 'Back to draft')}>Edit again</button>}
      </div>
      {confirm && <Confirm title={confirm.t} text={confirm.x} onClose={() => setConfirm(null)} onConfirm={() => act(confirm.a, 'Marked as sent')} />}
    </>
  );
}

export function PriceList() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => get('/price-list'), []);
  const [f, setF] = useState({ sku: '', name: '', product_type: '', decoration: 'Embroidery', min_qty: 20, unit_price: '' });
  const [run, busy] = useAction();
  return (
    <>
      <div className="page-head"><Link className="btn ghost" to="/quotes" aria-label="Back"><Icon name="back" /></Link><h1>Price list</h1></div>
      <p className="muted" style={{ marginTop: -8 }}>Only approved prices can be used in quotes, including AI drafts. Add quantity tiers by repeating an item code with a higher minimum.</p>
      <LoadError error={error} retry={reload} />
      {can('pricelist.write') && <form className="filters" onSubmit={e => { e.preventDefault(); run(() => post('/price-list', { ...f, min_qty: Number(f.min_qty), unit_price: Number(f.unit_price) }), 'Price saved and approved').then(() => { setF({ ...f, unit_price: '' }); reload(); }); }}>
        <Field label="Item code"><input className="in" required value={f.sku} onChange={e => setF({ ...f, sku: e.target.value.toUpperCase() })} style={{ width: 120 }} /></Field>
        <Field label="Name"><input className="in" required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Product"><input className="in" required value={f.product_type} onChange={e => setF({ ...f, product_type: e.target.value })} list="pl-products" style={{ width: 130 }} /></Field>
        <Field label="Decoration"><select className="in" value={f.decoration} onChange={e => setF({ ...f, decoration: e.target.value })}>{['DTF printing', 'Embroidery', 'Screen printing'].map(d => <option key={d}>{d}</option>)}</select></Field>
        <Field label="From qty"><input className="in" type="number" min="1" required value={f.min_qty} onChange={e => setF({ ...f, min_qty: e.target.value })} style={{ width: 90 }} /></Field>
        <Field label="Unit price ($)"><input className="in" type="number" min="0" step="0.01" required value={f.unit_price} onChange={e => setF({ ...f, unit_price: e.target.value })} style={{ width: 110 }} /></Field>
        <button className="btn primary" disabled={busy}>Save price</button>
        <datalist id="pl-products">{['T-shirts', 'Polos', 'Hoodies', 'Hats', 'Safety vests', 'Workwear'].map(p => <option key={p} value={p} />)}</datalist>
      </form>}
      {data && <div className="tscroll" style={{ '--t-offset': '300px' }}><table className="dt" style={{ width: '100%' }}>
        <thead><tr><th style={{ width: 120 }}>Code</th><th>Name</th><th>Product</th><th>Decoration</th><th style={{ width: 90 }}>From qty</th><th style={{ width: 100 }}>Unit</th><th>Approved</th><th style={{ width: 90 }}></th></tr></thead>
        <tbody>{data.filter(p => p.active).map(p => <tr key={p.id} style={{ cursor: 'default' }}><td>{p.sku}</td><td>{p.name}</td><td>{p.product_type}</td><td>{p.decoration}</td><td>{p.min_qty}+</td><td>{money(p.unit_price)}</td>
          <td>{p.approved_at ? <Pill tone="green">{p.approved_by_name || 'Approved'}</Pill> : <Pill tone="amber">Not approved</Pill>}</td>
          <td>{can('pricelist.write') && <button className="btn small" onClick={() => run(() => del(`/price-list/${p.id}`), 'Removed').then(reload)}>Remove</button>}</td></tr>)}</tbody></table></div>}
    </>
  );
}
