import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, qs } from '../lib/api.js';
import { useLoad, LoadError, useAction, Pill } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { dateShort, daysUntil, leadName } from '../lib/format.js';

const STAGES = ['New', 'Contacted', 'Waiting', 'Qualified', 'Quote Sent', 'Won', 'Lost'];

export default function Pipeline() {
  const nav = useNavigate();
  const { can } = useSession();
  const [owner, setOwner] = useState('');
  const facets = useLoad(() => get('/contacts/facets'), []);
  const { data, error, reload, setData } = useLoad(async () => {
    const all = await Promise.all(STAGES.map(s => get(`/contacts${qs({ status: s, owner, size: 100, sort: 'last_activity_at' })}`)));
    return Object.fromEntries(STAGES.map((s, i) => [s, all[i]]));
  }, [owner]);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const [run] = useAction();
  const move = async (card, to) => {
    if (card.status === to) return;
    setData(d => ({ ...d, [card.status]: { ...d[card.status], rows: d[card.status].rows.filter(r => r.id !== card.id), total: d[card.status].total - 1 }, [to]: { ...d[to], rows: [{ ...card, status: to }, ...d[to].rows], total: d[to].total + 1 } }));
    try { await run(() => patch(`/contacts/${card.id}`, { status: to }), `Lead ${card.lead_no} moved to ${to}`); } catch { reload(); }
  };
  return (
    <>
      <div className="page-head"><h1>Sales Pipeline</h1>
        <select className="in" style={{ width: 'auto' }} value={owner} onChange={e => setOwner(e.target.value)} aria-label="Responsible"><option value="">Everyone</option>{facets.data?.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        {owner && <button className="btn" onClick={() => setOwner('')}>Clear filters</button>}
      </div>
      <p className="muted" style={{ marginTop: -8 }}>Drag a card to change its stage{can('contacts.write') ? '' : ' (view only)'}. On a phone, open the customer and change the status there.</p>
      <LoadError error={error} retry={reload} />
      {data && <div className="board">
        {STAGES.map(s => (
          <div key={s} className={`col${over === s ? ' drop' : ''}`} onDragOver={e => { if (can('contacts.write')) { e.preventDefault(); setOver(s); } }} onDragLeave={() => setOver(null)}
            onDrop={() => { setOver(null); if (drag) move(drag, s); setDrag(null); }}>
            <h3><span>{s}</span><span className="muted">{data[s].total}</span></h3>
            {data[s].rows.map(c => { const d = daysUntil(c.deadline); return (
              <div key={c.id} className="bcard" draggable={can('contacts.write')} onDragStart={() => setDrag(c)} onClick={() => nav(`/customers/${c.id}`)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && nav(`/customers/${c.id}`)}>
                <b>{leadName(c)}</b>{c.company && c.name && <div className="small muted">{c.company}</div>}
                <div className="row small" style={{ marginTop: 4 }}>{c.product_type && <span>{c.quantity ? `${c.quantity} ` : ''}{c.product_type}</span>}{c.deadline && <Pill tone={d !== null && d < 7 ? 'amber' : ''}>Due {dateShort(c.deadline)}</Pill>}</div>
                {c.owner_name && <div className="small muted">{c.owner_name}</div>}
              </div>); })}
            {data[s].total > data[s].rows.length && <div className="small muted" style={{ padding: 6 }}>+{data[s].total - data[s].rows.length} more in the customer list</div>}
          </div>))}
      </div>}
    </>
  );
}
