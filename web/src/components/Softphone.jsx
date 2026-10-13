import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { get } from '../lib/api.js';
import { Icon } from './ui.jsx';

// Global softphone state so any "Call" button can dial.
const listeners = new Set();
let state = { open: false, number: '' };
const emit = () => listeners.forEach(l => l(state));
export function useSoftphone() {
  return { open: (number = '') => { state = { open: true, number }; emit(); }, close: () => { state = { ...state, open: false }; emit(); } };
}

export default function Softphone() {
  const [s, setS] = useState(state);
  const [status, setStatus] = useState('idle'); // idle, loading, ready, calling, in-call, error
  const [err, setErr] = useState(null);
  const [num, setNum] = useState('');
  const [muted, setMuted] = useState(false);
  const [incoming, setIncoming] = useState(null);
  const device = useRef(null); const call = useRef(null);
  useEffect(() => { const l = v => { setS(v); if (v.number) setNum(v.number); }; listeners.add(l); return () => listeners.delete(l); }, []);

  async function ensureDevice() {
    if (device.current) return device.current;
    setStatus('loading'); setErr(null);
    try {
      const [{ Device }, tok] = await Promise.all([import('@twilio/voice-sdk'), get('/calls/token')]);
      const d = new Device(tok.token, { logLevel: 'error', codecPreferences: ['opus', 'pcmu'] });
      d.on('error', e => { setErr({ message: e.message || 'Phone error' }); });
      d.on('incoming', c => { setIncoming(c); state = { ...state, open: true }; emit(); c.on('cancel', () => setIncoming(null)); c.on('disconnect', () => { setIncoming(null); setStatus('ready'); call.current = null; }); });
      d.on('tokenWillExpire', async () => { try { d.updateToken((await get('/calls/token')).token); } catch { /* next call will refetch */ } });
      await d.register();
      device.current = d; setStatus('ready');
      return d;
    } catch (e) { setStatus('error'); setErr(e); throw e; }
  }
  useEffect(() => { if (s.open && !device.current) ensureDevice().catch(() => {}); }, [s.open]); // eslint-disable-line

  async function dial() {
    if (!num.trim()) return;
    const d = await ensureDevice();
    setStatus('calling');
    const c = await d.connect({ params: { To: num } });
    call.current = c;
    c.on('accept', () => setStatus('in-call'));
    c.on('disconnect', () => { setStatus('ready'); call.current = null; setMuted(false); });
    c.on('cancel', () => setStatus('ready'));
    c.on('error', e => { setErr({ message: e.message }); setStatus('ready'); });
  }
  if (!s.open) return null;
  const active = status === 'calling' || status === 'in-call';
  return (
    <div className="softphone" role="dialog" aria-label="Phone">
      <div className="row"><b>Phone</b><span className="spacer" /><span className="muted small">{{ loading: 'Connecting…', ready: 'Ready', calling: 'Calling…', 'in-call': 'On call', error: 'Not available', idle: '' }[status]}</span>
        {!active && <button className="btn ghost small" onClick={() => { state = { ...state, open: false }; emit(); }} aria-label="Close phone"><Icon name="x" /></button>}</div>
      {err && <div className="notice bad small" style={{ marginTop: 8 }}>{err.message}{err.hint && <div>{err.hint}</div>}</div>}
      {incoming && !active && <div className="notice warn" style={{ marginTop: 8 }}>Incoming call from {incoming.parameters?.From || 'unknown'}
        <div className="row" style={{ marginTop: 6 }}><button className="btn primary small" onClick={() => { incoming.accept(); call.current = incoming; setStatus('in-call'); setIncoming(null); }}>Answer</button><button className="btn small" onClick={() => { incoming.reject(); setIncoming(null); }}>Decline</button></div></div>}
      <input className="in" style={{ marginTop: 10, fontSize: '1.2rem', textAlign: 'center' }} type="tel" value={num} onChange={e => setNum(e.target.value)} placeholder="Phone number" aria-label="Phone number" disabled={active}
        onKeyDown={e => { if (e.key === 'Enter') dial(); }} />
      <div className="keypad">{'123456789*0#'.split('').map(k => <button key={k} onClick={() => active ? call.current?.sendDigits(k) : setNum(n => n + k)}>{k}</button>)}</div>
      {!active
        ? <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={status === 'loading' || status === 'error' || !num} onClick={() => dial().catch(e => setErr(e))}><Icon name="phone" />Call</button>
        : <div className="row"><button className="btn" onClick={() => { call.current?.mute(!muted); setMuted(!muted); }}>{muted ? 'Unmute' : 'Mute'}</button><span className="spacer" /><button className="btn danger" onClick={() => call.current?.disconnect()}>Hang up</button></div>}
      <p className="muted small" style={{ margin: '8px 0 0' }}>Calls show your business number. Numbers on the Do Not Call list are blocked.</p>
    </div>
  );
}
