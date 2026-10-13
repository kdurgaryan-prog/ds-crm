import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, useAction, Switch, Modal, Field, Icon } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { dateTime } from '../lib/format.js';

const LANGS = { en: 'English', hy: 'Armenian', ru: 'Russian', es: 'Spanish' };
const SCOPES = { industry: 'Industry', product_type: 'Product', decoration: 'Decoration', quantity: 'Quantity', source: 'Lead source', status: 'Status', created_at: 'Date created', company: 'Company names' };

export default function Agents() {
  const { can, reload: reloadMe } = useSession();
  const { data, error, reload } = useLoad(() => get('/agents'), []);
  const [filter, setFilter] = useState({ agent: '', result: '' });
  const log = useLoad(() => get(`/agents/actions${qs(filter)}`), [JSON.stringify(filter)]);
  const [rules, setRules] = useState(null);
  const [run] = useAction();
  if (error) return <LoadError error={error} retry={reload} />;
  if (!data) return <div className="empty">Loading…</div>;
  const owner = can('agents.control');
  const set = (agent, body, msg) => run(() => patch(`/agents/${agent}`, body), msg).then(() => { reload(); log.reload(); reloadMe(); });
  const n = data.natalie; const a = data.arev;
  const stat = (agent, r) => data.stats.filter(s => s.agent === agent && (!r || s.result === r)).reduce((x, s) => x + s.n, 0);
  return (
    <>
      <div className="page-head"><h1>AI Agents</h1>{!data.aiConfigured && <Pill tone="red">AI not set up on the server</Pill>}</div>
      {!data.aiConfigured && <div className="notice warn" style={{ marginBottom: 14 }}>The AI key is missing on the server, so neither agent can answer or write. Messages wait for staff instead. See <Link to="/settings/channels">Settings → Channels</Link>.</div>}
      <div className="dash-cols">
        <section className="panel">
          <div className={`kill ${n.enabled ? 'on' : 'off'}`}>
            <Icon name="power" />
            <div style={{ flex: 1 }}><h2 style={{ margin: 0 }}>{n.displayName}</h2><div className="small muted">Calls and messages · sales assistant</div></div>
            {owner ? <button className={`btn ${n.enabled ? 'danger' : 'primary'}`} onClick={() => set('natalie', { enabled: !n.enabled }, n.enabled ? `${n.displayName} turned off everywhere` : `${n.displayName} turned on`)}>{n.enabled ? 'Turn off' : 'Turn on'}</button> : <Pill tone={n.enabled ? 'green' : 'red'}>{n.enabled ? 'On' : 'Off'}</Pill>}
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <Switch disabled={!owner || !n.enabled} checked={n.autoReplyMessages} onChange={v => set('natalie', { autoReplyMessages: v }, 'Saved')} label="Answers messages on her own" />
            <Switch disabled={!owner || !n.enabled} checked={n.answerCalls} onChange={v => set('natalie', { answerCalls: v }, 'Saved')} label="Answers incoming calls" />
            <Switch disabled={!owner || !n.enabled} checked={n.outboundCalls} onChange={v => set('natalie', { outboundCalls: v }, 'Saved')} label="Makes approved campaign calls" />
            <Field label="Languages she may switch to (only when the customer asks)"><div className="row">{Object.entries(LANGS).map(([k, l]) => <label key={k} className="row"><input type="checkbox" disabled={!owner || k === 'en'} checked={n.languages.includes(k)} onChange={e => set('natalie', { languages: e.target.checked ? [...n.languages, k] : n.languages.filter(x => x !== k) }, 'Saved')} />{l}</label>)}</div></Field>
          </div>
          <dl className="kv" style={{ marginTop: 14 }}><dt>Last 7 days</dt><dd>{stat('natalie')} actions, {stat('natalie', 'blocked')} stopped by safety rules</dd>
            <dt>Conversations</dt><dd>{data.aiConversations.ai_on} with AI on, {data.aiConversations.paused} handled by staff</dd>
            <dt>AI quote drafts</dt><dd>{data.pendingQuotes} waiting for review</dd></dl>
          <button className="btn small" style={{ marginTop: 10 }} onClick={async () => setRules((await get('/agents/natalie/prompt')).text)}>See her rules</button>
        </section>
        <section className="panel">
          <div className={`kill ${a.enabled ? 'on' : 'off'}`}>
            <Icon name="power" />
            <div style={{ flex: 1 }}><h2 style={{ margin: 0 }}>{a.displayName}</h2><div className="small muted">Marketing drafts · never publishes without you</div></div>
            {owner ? <button className={`btn ${a.enabled ? 'danger' : 'primary'}`} onClick={() => set('arev', { enabled: !a.enabled }, a.enabled ? `${a.displayName} turned off` : `${a.displayName} turned on`)}>{a.enabled ? 'Turn off' : 'Turn on'}</button> : <Pill tone={a.enabled ? 'green' : 'red'}>{a.enabled ? 'On' : 'Off'}</Pill>}
          </div>
          <Field label="What she may look at (totals only — never phone numbers, emails or messages)">
            <div className="row" style={{ marginTop: 6 }}>{Object.entries(SCOPES).map(([k, l]) => <label key={k} className="row"><input type="checkbox" disabled={!owner} checked={a.dataScopes.includes(k)} onChange={e => set('arev', { dataScopes: e.target.checked ? [...a.dataScopes, k] : a.dataScopes.filter(x => x !== k) }, 'Saved')} />{l}</label>)}</div></Field>
          <dl className="kv" style={{ marginTop: 14 }}><dt>Last 7 days</dt><dd>{stat('arev')} drafts and actions</dd><dt>Waiting for you</dt><dd><Link to="/marketing?status=pending_approval">{data.pendingApprovals} to approve</Link></dd></dl>
          {owner && <NameEditor agents={{ natalie: n.displayName, arev: a.displayName }} onSave={(k, v) => set(k, { displayName: v }, 'Name updated everywhere')} />}
        </section>
      </div>
      <section className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Activity log</h2><span className="spacer" />
          <select className="in" style={{ width: 'auto' }} value={filter.agent} onChange={e => setFilter({ ...filter, agent: e.target.value })} aria-label="Agent"><option value="">Both agents</option><option value="natalie">{n.displayName}</option><option value="arev">{a.displayName}</option></select>
          <select className="in" style={{ width: 'auto' }} value={filter.result} onChange={e => setFilter({ ...filter, result: e.target.value })} aria-label="Result"><option value="">Any result</option><option value="ok">Done</option><option value="blocked">Stopped by rules</option><option value="skipped">Skipped</option><option value="error">Error</option></select></div>
        <LoadError error={log.error} retry={log.reload} />
        <div className="tscroll" style={{ '--t-offset': '460px', minHeight: 200 }}><table className="dt" style={{ width: '100%' }}>
          <thead><tr><th style={{ width: 140 }}>When</th><th style={{ width: 100 }}>Agent</th><th style={{ width: 160 }}>Action</th><th>Based on</th><th>Change</th><th style={{ width: 120 }}>Approval</th><th style={{ width: 110 }}>Result</th></tr></thead>
          <tbody>{(log.data || []).map(x => <tr key={x.id} style={{ cursor: 'default' }}>
            <td>{dateTime(x.created_at)}</td><td>{x.agent === 'natalie' ? n.displayName : a.displayName}</td><td>{x.action.replace(/_/g, ' ')}</td>
            <td className="small" title={JSON.stringify(x.based_on)}>{JSON.stringify(x.based_on)}</td><td className="small" title={JSON.stringify(x.change)}>{JSON.stringify(x.change)}</td>
            <td>{x.approval_required ? <Pill tone={x.approval_status === 'approved' ? 'green' : x.approval_status === 'rejected' ? 'red' : 'amber'}>{x.approval_status}</Pill> : <span className="muted">Not needed</span>}</td>
            <td title={x.detail || ''}><Pill tone={x.result === 'ok' ? 'green' : x.result === 'blocked' || x.result === 'error' ? 'red' : 'amber'}>{x.result}</Pill></td></tr>)}</tbody></table></div>
      </section>
      {rules && <Modal title={`${n.displayName}'s rules`} wide onClose={() => setRules(null)}><p className="muted" style={{ margin: 0 }}>These are the instructions she follows. On top of them, the system blocks prices, made-up confirmations and email requests before anything is sent.</p><pre className="code">{rules}</pre></Modal>}
    </>
  );
}

function NameEditor({ agents, onSave }) {
  const [v, setV] = useState(agents);
  return <div className="grid2" style={{ marginTop: 14 }}>
    {Object.entries(v).map(([k, name]) => <Field key={k} label={k === 'natalie' ? 'Sales agent name' : 'Marketing agent name'}><div className="row"><input className="in" style={{ flex: 1 }} value={name} onChange={e => setV({ ...v, [k]: e.target.value })} />{name !== agents[k] && <button className="btn small" onClick={() => onSave(k, name)}>Save</button>}</div></Field>)}
  </div>;
}
