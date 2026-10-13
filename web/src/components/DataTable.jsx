// Customizable table: drag to reorder columns, drag edge to resize, show/hide, row height,
// two-line headers, saved personal views with Preview / Save / Reset. Sorting is done by the server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Modal, Field, useAction, Switch } from './ui.jsx';
import { get, post, put, del } from '../lib/api.js';

export function useTableView(tableKey, defaultColumns) {
  const def = useMemo(() => ({ columns: defaultColumns.map(c => ({ key: c.key, width: c.width || 160, hidden: !!c.hidden })), rowHeight: 44, wrapHeaders: true }), [tableKey]); // eslint-disable-line
  const [views, setViews] = useState([]);
  const [viewId, setViewId] = useState(null);
  const [config, setConfig] = useState(def);
  const [saved, setSaved] = useState(def);
  const load = async (selectId) => {
    const vs = await get(`/settings/views/${tableKey}`).catch(() => []);
    setViews(vs);
    const pick = vs.find(v => v.id === selectId) || vs.find(v => v.is_default && v.user_id) || null;
    if (pick) { setViewId(pick.id); const cfg = normalize(pick.config); setConfig(cfg); setSaved(cfg); }
  };
  const normalize = cfg => {
    const known = new Map((cfg.columns || []).map(c => [c.key, c]));
    const cols = (cfg.columns || []).filter(c => defaultColumns.some(d => d.key === c.key));
    for (const d of defaultColumns) if (!known.has(d.key)) cols.push({ key: d.key, width: d.width || 160, hidden: true });
    return { ...def, ...cfg, columns: cols };
  };
  useEffect(() => { load(); }, [tableKey]); // eslint-disable-line
  // columns added later (e.g., custom fields) appear as hidden, ready to switch on
  const keys = defaultColumns.map(c => c.key).join('|');
  useEffect(() => { setConfig(c => normalize(c)); setSaved(c => normalize(c)); }, [keys]); // eslint-disable-line
  return {
    views, viewId, config, setConfig, saved, def,
    dirty: JSON.stringify(config) !== JSON.stringify(saved),
    select: id => { const v = views.find(x => x.id === id); setViewId(v?.id || null); const cfg = v ? normalize(v.config) : def; setConfig(cfg); setSaved(cfg); },
    save: async (name, { asNew = false, shared = false, config: override } = {}) => {
      const cfg = override || config;
      const body = { name, config: cfg, is_default: !shared, shared };
      const v = viewId && !asNew ? await put(`/settings/views/${tableKey}/${viewId}`, body) : await post(`/settings/views/${tableKey}`, body);
      await load(v.id); setConfig(cfg); setSaved(cfg); return v;
    },
    remove: async () => { if (viewId) { await del(`/settings/views/${tableKey}/${viewId}`); setViewId(null); setConfig(def); setSaved(def); await load(); } },
    reset: () => setConfig(def),
    revert: () => setConfig(saved),
  };
}

export function ColumnsEditor({ view, columns, onClose }) {
  const [draft, setDraft] = useState(view.config);
  const [name, setName] = useState(view.views.find(v => v.id === view.viewId)?.name || 'My view');
  const [run, busy] = useAction();
  const label = k => columns.find(c => c.key === k)?.label || k;
  const move = (i, d) => { const cols = [...draft.columns]; const j = i + d; if (j < 0 || j >= cols.length) return; [cols[i], cols[j]] = [cols[j], cols[i]]; setDraft({ ...draft, columns: cols }); };
  return (
    <Modal title="Columns and view" onClose={() => { view.revert(); onClose(); }} wide footer={<>
      <button className="btn" onClick={() => { setDraft(view.def); view.reset(); }}>Reset to original</button>
      <span className="spacer" />
      <button className="btn" onClick={() => view.setConfig(draft)}>Preview</button>
      <button className="btn primary" disabled={busy} onClick={async () => { view.setConfig(draft); await run(() => view.save(name, { config: draft }), 'View saved'); onClose(); }}>Save view</button>
    </>}>
      <p className="muted" style={{ margin: 0 }}>Show, hide and order columns. Widths can also be changed by dragging a column's edge in the table, and columns can be dragged by their header.</p>
      <div className="grid2">
        <Field label="View name"><input className="in" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Row height"><div className="seg">{[['Compact', 34], ['Normal', 44], ['Roomy', 58]].map(([l, h]) => <button key={h} type="button" className={draft.rowHeight === h ? 'on' : ''} onClick={() => setDraft({ ...draft, rowHeight: h })}>{l}</button>)}</div></Field>
      </div>
      <Switch checked={draft.wrapHeaders} onChange={v => setDraft({ ...draft, wrapHeaders: v })} label="Allow long headers on two lines" />
      <ul className="list">
        {draft.columns.map((c, i) => (
          <li key={c.key} className="row" style={{ padding: '6px 0' }}>
            <Switch checked={!c.hidden} onChange={v => setDraft({ ...draft, columns: draft.columns.map(x => x.key === c.key ? { ...x, hidden: !v } : x) })} label={label(c.key)} />
            <span className="spacer" />
            <label className="row small muted">Width <input className="in" style={{ width: 80, minHeight: 30 }} type="number" min="60" max="600" value={c.width} onChange={e => setDraft({ ...draft, columns: draft.columns.map(x => x.key === c.key ? { ...x, width: Number(e.target.value) || 120 } : x) })} /></label>
            <button className="btn small" onClick={() => move(i, -1)} aria-label={`Move ${label(c.key)} up`} disabled={i === 0}>Up</button>
            <button className="btn small" onClick={() => move(i, 1)} aria-label={`Move ${label(c.key)} down`} disabled={i === draft.columns.length - 1}>Down</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export default function DataTable({ columns, rows, view, onRowClick, sort, dir, onSort, rowKey = 'id', offset = 250, empty }) {
  const cfg = view.config;
  const byKey = useMemo(() => Object.fromEntries(columns.map(c => [c.key, c])), [columns]);
  const visible = cfg.columns.filter(c => !c.hidden && byKey[c.key]);
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const resizing = useRef(null);
  useEffect(() => {
    const move = e => {
      const r = resizing.current; if (!r) return;
      const w = Math.max(60, Math.min(800, r.w + (e.clientX - r.x)));
      view.setConfig(c => ({ ...c, columns: c.columns.map(x => x.key === r.key ? { ...x, width: w } : x) }));
    };
    const up = () => { resizing.current = null; document.body.style.cursor = ''; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [view]);
  const drop = target => {
    if (!dragKey || dragKey === target) return;
    view.setConfig(c => {
      const cols = [...c.columns]; const from = cols.findIndex(x => x.key === dragKey); const [m] = cols.splice(from, 1);
      cols.splice(cols.findIndex(x => x.key === target), 0, m); return { ...c, columns: cols };
    });
  };
  return (
    <div className="tscroll" style={{ '--t-offset': `${offset}px`, '--row-h': `${cfg.rowHeight}px` }}>
      <table className={`dt${cfg.wrapHeaders ? ' wrap-head' : ''}`}>
        <colgroup>{visible.map(c => <col key={c.key} style={{ width: c.width }} />)}</colgroup>
        <thead><tr>
          {visible.map(c => {
            const col = byKey[c.key];
            const sorted = sort === (col.sortKey || c.key);
            return (
              <th key={c.key} className={overKey === c.key && dragKey && dragKey !== c.key ? 'drop' : ''} draggable
                onDragStart={e => { setDragKey(c.key); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={e => { e.preventDefault(); setOverKey(c.key); }}
                onDragLeave={() => setOverKey(null)} onDrop={() => { drop(c.key); setDragKey(null); setOverKey(null); }} onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                <div className="th-in">
                  <span className="lbl" title={col.label} onClick={() => col.sortable !== false && onSort?.(col.sortKey || c.key)}>{col.label}{sorted ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                </div>
                <span className="rs" onPointerDown={e => { e.preventDefault(); e.stopPropagation(); resizing.current = { key: c.key, x: e.clientX, w: c.width }; document.body.style.cursor = 'col-resize'; }} />
              </th>
            );
          })}
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r[rowKey]} onClick={() => onRowClick?.(r)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onRowClick?.(r); }}>
              {visible.map(c => { const col = byKey[c.key]; const v = col.render ? col.render(r) : r[c.key]; return <td key={c.key} title={typeof v === 'string' ? v : undefined}>{v ?? ''}</td>; })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (empty || <div className="empty">Nothing here yet.</div>)}
    </div>
  );
}

export function ViewBar({ view, columns, extra }) {
  const [editing, setEditing] = useState(false);
  const [run, busy] = useAction();
  return (
    <>
      <select className="in" style={{ width: 'auto' }} value={view.viewId || ''} onChange={e => view.select(e.target.value || null)} aria-label="Saved view">
        <option value="">Standard view</option>
        {view.views.map(v => <option key={v.id} value={v.id}>{v.name}{v.user_id ? '' : ' (shared)'}</option>)}
      </select>
      <button className="btn" onClick={() => setEditing(true)}><Icon name="columns" />Columns</button>
      {view.dirty && <>
        <button className="btn primary" disabled={busy} onClick={() => run(() => view.save(view.views.find(v => v.id === view.viewId)?.name || 'My view'), 'View saved')}>Save view</button>
        <button className="btn" onClick={view.revert}>Undo changes</button>
      </>}
      {extra}
      {editing && <ColumnsEditor view={view} columns={columns} onClose={() => setEditing(false)} />}
    </>
  );
}
