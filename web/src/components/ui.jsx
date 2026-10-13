import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---------- icons (simple line icons) ----------
const P = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.87M15.5 3.13a3.5 3.5 0 0 1 0 6.75',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  pipeline: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z',
  quote: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7L12 12l8.7-5M12 22V12',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a3 3 0 0 1 0 6M18 6a7 7 0 0 1 0 12',
  calendar: 'M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6L6 18M6 6l12 12',
  menu: 'M3 6h18M3 12h18M3 18h18',
  check: 'M20 6L9 17l-5-5',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  clip: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  task: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  columns: 'M12 3v18M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  stop: 'M5 5h14v14H5z',
  play: 'M5 3l14 9-14 9z',
  power: 'M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10',
  back: 'M19 12H5M12 19l-7-7 7-7',
};
export function Icon({ name, className = 'ico', title }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>{title && <title>{title}</title>}<path d={P[name] || P.more} /></svg>;
}

// ---------- toasts ----------
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setItems(x => [...x, { id, ...t }]);
    setTimeout(() => setItems(x => x.filter(i => i.id !== id)), t.kind === 'error' ? 9000 : 4000);
  }, []);
  const api = { ok: (msg) => push({ kind: 'ok', msg }), info: (msg) => push({ kind: 'info', msg }), error: (e) => push({ kind: 'error', msg: e?.message || String(e), hint: e?.hint }) };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast ${t.kind}`}><div>{t.msg}{t.hint && <span className="hint">{t.hint}</span>}</div>
          <button className="btn ghost small" style={{ color: 'inherit', marginLeft: 'auto' }} onClick={() => setItems(x => x.filter(i => i.id !== t.id))} aria-label="Dismiss"><Icon name="x" /></button></div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- data loading ----------
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setState(s => ({ ...s, loading: true }));
    try { const data = await fn(); if (my === seq.current) setState({ data, error: null, loading: false }); }
    catch (error) { if (my === seq.current) setState(s => ({ ...s, error, loading: false })); }
  }, deps); // eslint-disable-line
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, setData: d => setState(s => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function LoadError({ error, retry }) {
  if (!error) return null;
  return <div className="notice bad" role="alert"><b>{error.message}</b>{error.hint && <div className="small">{error.hint}</div>}{retry && <div style={{ marginTop: 8 }}><button className="btn small" onClick={retry}>Try again</button></div>}</div>;
}

// ---------- building blocks ----------
export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const k = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    ref.current?.querySelector('input,select,textarea,button:not(.close)')?.focus();
    return () => { document.removeEventListener('keydown', k); prev?.focus?.(); };
  }, []); // eslint-disable-line
  return (
    <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header><h2>{title}</h2><button className="btn ghost close" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, error, children, hint }) {
  return <label className="field"><span>{label}</span>{children}{hint && !error && <small className="muted">{hint}</small>}{error && <small className="err">{error}</small>}</label>;
}

export function Switch({ checked, onChange, label, disabled }) {
  return <label className="switch"><input type="checkbox" checked={!!checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className="tr" /><span>{label}</span></label>;
}

export const Pill = ({ tone = '', children, title }) => <span className={`pill ${tone}`} title={title}>{children}</span>;

export function Empty({ title, children, action }) {
  return <div className="empty"><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

/** Runs an async action, shows the result, keeps the form on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try { const r = await fn(); if (okMsg) toast.ok(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }
    catch (e) { toast.error(e); throw e; }
    finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

export function Confirm({ title, text, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
    <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch { setBusy(false); } }}>{confirmLabel}</button></>}>
    <p style={{ margin: 0 }}>{text}</p></Modal>;
}
