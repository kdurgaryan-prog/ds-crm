import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post, del, qs } from '../lib/api.js';
import { useLoad, LoadError, Pill, Field, useAction, Empty, Icon, Modal, Confirm } from '../components/ui.jsx';
import { useSession } from '../lib/session.jsx';
import { dateTime, dateShort, CHANNEL } from '../lib/format.js';

export const KINDS = { social_post: 'Social post', ad_copy: 'Ad copy', sms_blast: 'Text message campaign', whatsapp_blast: 'WhatsApp campaign', call_campaign: 'Call campaign (Natalie)', email_blast: 'Email campaign', image_prompt: 'Image prompt', video_script: 'Video script', content_calendar: 'Content calendar' };
const ST = { draft: ['Draft', ''], pending_approval: ['Waiting for approval', 'amber'], approved: ['Approved', 'blue'], scheduled: ['Scheduled', 'blue'], running: ['Running', 'green'], paused: ['Paused', 'amber'], stopped: ['Stopped', 'red'], published: ['Published', 'green'], completed: ['Completed', 'green'], failed: ['Failed', 'red'], rejected: ['Sent back', 'red'] };
const SENDS = ['social_post', 'sms_blast', 'whatsapp_blast', 'call_campaign', 'email_blast'];

export default function Marketing() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const { can, me } = useSession();
  const status = sp.get('status') || '';
  const { data, error, reload } = useLoad(() => get(`/marketing${qs({ status })}`), [status]);
  const sugg = useLoad(() => get('/marketing/suggestions'), []);
  const [ask, setAsk] = useState(null);
  return (
    <>
      <div className="page-head"><h1>Marketing</h1>
        <div className="seg">{[['', 'All'], ['draft,rejected', 'Drafts'], ['pending_approval', 'Waiting for approval'], ['running,scheduled,paused', 'Active'], ['published,completed,stopped,failed', 'Finished']].map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setSp(k ? { status: k } : {})}>{l}</button>)}</div>
        {can('marketing.write') && <button className="btn primary" onClick={() => setAsk({ kind: 'social_post', brief: '' })}><Icon name="spark" />Ask {me.agents.arev}</button>}
        {can('marketing.write') && <button className="btn" onClick={() => setAsk({ kind: 'sms_blast', brief: '', manual: true })}><Icon name="plus" />Write my own</button>}
      </div>
      <div className="notice" style={{ marginBottom: 14 }}>Everything starts as a draft. Nothing is posted, texted or called until the owner reviews the final text, files, channels, audience and time, and approves it.</div>
      {sugg.data?.suggestions?.length > 0 && can('marketing.write') && <section className="panel" style={{ marginBottom: 14 }}>
        <h2>Ideas from what Natalie heard</h2>
        <ul className="list">{sugg.data.suggestions.map((s, i) => <li key={i}><button className="li" onClick={() => setAsk({ kind: s.kind, brief: s.brief })}><Pill>{KINDS[s.kind]}</Pill><span>{s.brief}</span></button></li>)}</ul>
      </section>}
      <LoadError error={error} retry={reload} />
      {data && (data.length === 0 ? <Empty title="No marketing items here">Ask {me.agents.arev} for a post, an ad or a content calendar.</Empty> :
        <div className="tscroll" style={{ '--t-offset': '330px' }}><table className="dt" style={{ width: '100%' }}>
          <thead><tr><th>Title</th><th style={{ width: 190 }}>Type</th><th style={{ width: 170 }}>Status</th><th style={{ width: 120 }}>Made by</th><th style={{ width: 130 }}>Reached</th><th style={{ width: 140 }}>Updated</th></tr></thead>
          <tbody>{data.map(c => <tr key={c.id} onClick={() => nav(`/marketing/${c.id}`)}>
            <td>{c.title}</td><td>{KINDS[c.kind]}</td><td><Pill tone={ST[c.status][1]}>{ST[c.status][0]}</Pill></td>
            <td>{c.created_by_agent ? `${me.agents.arev} (AI)` : 'Staff'}</td><td>{c.recipients ? `${c.reached} of ${c.recipients}` : '—'}</td><td>{dateTime(c.updated_at)}</td></tr>)}</tbody></table></div>)}
      {ask && <AskArev init={ask} onClose={() => setAsk(null)} onDone={c => nav(`/marketing/${c.id}`)} />}
    </>
  );
}

function AskArev({ init, onClose, onDone }) {
  const { me } = useSession();
  const [f, setF] = useState({ kind: init.kind, brief: init.brief, channels: init.kind === 'social_post' ? ['instagram', 'messenger'] : [], title: '' });
  const [run, busy] = useAction();
  const go = () => init.manual
    ? run(() => post('/marketing', { kind: f.kind, title: f.title || KINDS[f.kind], content: { text: '', channels: f.channels } }), 'Draft created').then(onDone)
    : run(() => post('/marketing/arev', { kind: f.kind, brief: f.brief, channels: f.channels }), `${me.agents.arev} wrote a draft`).then(onDone).catch(() => {});
  return (
    <Modal title={init.manual ? 'New draft' : `Ask ${me.agents.arev} for a draft`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Writing…' : init.manual ? 'Create draft' : 'Write draft'}</button></>}>
      <Field label="What do you need?"><select className="in" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value, channels: e.target.value === 'social_post' ? ['instagram', 'messenger'] : [] })}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      {init.manual ? <Field label="Title"><input className="in" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field>
        : <Field label="Brief" hint="Who it's for, what to say, any offer or date. Arev never invents reviews or results."><textarea className="in" rows={4} value={f.brief} onChange={e => setF({ ...f, brief: e.target.value })} placeholder="e.g. Hi-vis vests with logo for construction crews before winter" /></Field>}
      {f.kind === 'social_post' && <Field label="Post to"><div className="row">{['instagram', 'messenger'].map(ch => <label key={ch} className="row"><input type="checkbox" checked={f.channels.includes(ch)} onChange={e => setF({ ...f, channels: e.target.checked ? [...f.channels, ch] : f.channels.filter(x => x !== ch) })} />{ch === 'messenger' ? 'Facebook Page' : 'Instagram'}</label>)}</div></Field>}
    </Modal>
  );
}

export function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useSession();
  const { data: c, error, reload } = useLoad(() => get(`/marketing/${id}`), [id]);
  const facets = useLoad(() => get('/contacts/facets'), []);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [run, busy] = useAction();
  if (error) return <LoadError error={error} retry={reload} />;
  if (!c) return <div className="empty">Loading…</div>;
  const editable = can('marketing.write') && ['draft', 'rejected', 'pending_approval', 'approved', 'paused'].includes(c.status);
  const content = draft || c.content;
  const set = (k, v) => setDraft({ ...content, [k]: v });
  const aud = content.audience || {};
  const setAud = (k, v) => set('audience', { ...aud, [k]: v });
  const save = () => run(() => patch(`/marketing/${id}`, { content }), c.status === 'approved' ? 'Saved — it needs approval again' : 'Draft saved').then(() => { setDraft(null); reload(); });
  const openPreview = async () => setPreview(await run(() => get(`/marketing/${id}/preview`)));
  const sends = SENDS.includes(c.kind);
  return (
    <>
      <div className="page-head"><button className="btn ghost" onClick={() => nav('/marketing')} aria-label="Back"><Icon name="back" /></button><h1>{c.title}</h1><Pill tone={ST[c.status][1]}>{ST[c.status][0]}</Pill><span className="muted">{KINDS[c.kind]}{c.created_by_agent ? ` · drafted by ${me.agents.arev}` : ''}</span></div>
      {content.warnings?.length > 0 && <div className="notice warn" style={{ marginBottom: 12 }}>{content.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
      {c.result?.rejectNote && <div className="notice bad" style={{ marginBottom: 12 }}>Sent back: {c.result.rejectNote}</div>}
      {c.result?.pausedReason && <div className="notice warn" style={{ marginBottom: 12 }}>Paused: {c.result.pausedReason}</div>}
      {c.result?.mode && <div className={`notice ${c.status === 'failed' ? 'bad' : 'good'}`} style={{ marginBottom: 12 }}>Publishing: {c.result.mode}. {Object.entries(c.result.publish || {}).map(([k, r]) => `${k === 'messenger' ? 'Facebook' : k}: ${r.ok ? (r.sandbox ? 'test only' : 'posted') : r.error}`).join('; ')}</div>}
      <div className="card-grid">
        <section className="panel">
          <h2>Content</h2>
          {c.kind === 'email_blast' && <Field label="Subject" hint="{first_name} and {company} are filled in per person."><input className="in" disabled={!editable} value={content.subject || ''} onChange={e => set('subject', e.target.value)} maxLength={200} /></Field>}
          <textarea className="in" rows={14} disabled={!editable} value={content.text || ''} onChange={e => set('text', e.target.value)} aria-label="Content" />
          {c.kind === 'email_blast' && <div className="small muted">Plain text. An unsubscribe link and your signature are added to every email automatically. People who unsubscribed or have no email are skipped.</div>}
          {c.kind === 'sms_blast' && <div className="small muted">{(content.text || '').length} characters. Keep "Reply STOP to opt out".</div>}
          {c.kind === 'whatsapp_blast' && <Field label="Approved WhatsApp template ID" hint="WhatsApp only allows approved templates for marketing."><input className="in" disabled={!editable} value={content.template_sid || ''} onChange={e => set('template_sid', e.target.value)} placeholder="HX…" /></Field>}
          {content.brief && <p className="small muted">Brief: {content.brief}</p>}
        </section>
        <section className="panel">
          <h2>Where and when</h2>
          {c.kind === 'social_post' && <Field label="Post to"><div className="row">{['instagram', 'messenger'].map(ch => <label key={ch} className="row"><input type="checkbox" disabled={!editable} checked={(content.channels || []).includes(ch)} onChange={e => set('channels', e.target.checked ? [...(content.channels || []), ch] : content.channels.filter(x => x !== ch))} />{ch === 'messenger' ? 'Facebook Page' : 'Instagram'}</label>)}</div></Field>}
          {sends && <Field label="Schedule (optional)"><input className="in" type="datetime-local" disabled={!editable} value={content.schedule_at ? new Date(new Date(content.schedule_at) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} onChange={e => set('schedule_at', e.target.value ? new Date(e.target.value).toISOString() : null)} /></Field>}
          {['sms_blast', 'whatsapp_blast', 'call_campaign', 'email_blast'].includes(c.kind) && facets.data && <>
            <h3 style={{ margin: '12px 0 6px' }}>Audience</h3>
            <Field label="Status"><select className="in" multiple size={4} disabled={!editable} value={aud.statuses || []} onChange={e => setAud('statuses', [...e.target.selectedOptions].map(o => o.value))}>{facets.data.statuses.map(s => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Source"><select className="in" multiple size={4} disabled={!editable} value={aud.sources || []} onChange={e => setAud('sources', [...e.target.selectedOptions].map(o => o.value))}>{facets.data.sources.map(s => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Industry"><select className="in" multiple size={4} disabled={!editable} value={aud.industries || []} onChange={e => setAud('industries', [...e.target.selectedOptions].map(o => o.value))}>{(facets.data.industries || []).map(s => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Industry type"><select className="in" multiple size={4} disabled={!editable} value={aud.industryTypes || []} onChange={e => setAud('industryTypes', [...e.target.selectedOptions].map(o => o.value))}>{(facets.data.industryTypes || []).map(s => <option key={s}>{s}</option>)}</select></Field>
            <Field label="County"><select className="in" multiple size={4} disabled={!editable} value={aud.counties || []} onChange={e => setAud('counties', [...e.target.selectedOptions].map(o => o.value))}>{(facets.data.counties || []).map(s => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Product"><select className="in" multiple size={4} disabled={!editable} value={aud.productTypes || []} onChange={e => setAud('productTypes', [...e.target.selectedOptions].map(o => o.value))}>{facets.data.products.map(s => <option key={s}>{s}</option>)}</select></Field>
            <p className="small muted">Hold Ctrl or ⌘ to choose several. People without consent, on the Do Not Call list or opted out are skipped automatically.</p>
          </>}
          {c.recipients?.length > 0 && <><h3 style={{ margin: '12px 0 6px' }}>Results</h3>
            <div className="row">{c.counts.map(x => <Pill key={x.status} tone={x.status === 'skipped' ? 'amber' : x.status === 'failed' ? 'red' : 'green'}>{x.status}: {x.n}</Pill>)}</div>
            <ul className="list small" style={{ maxHeight: 220, overflow: 'auto', marginTop: 6 }}>{c.recipients.map((r, i) => <li key={i} style={{ padding: '4px 0' }}>Lead {r.lead_no} {r.name || r.company} — {r.status}{r.skip_reason ? `: ${r.skip_reason}` : ''}</li>)}</ul></>}
        </section>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        {editable && draft && <button className="btn" disabled={busy} onClick={save}>Save draft</button>}
        {can('marketing.write') && ['draft', 'rejected'].includes(c.status) && <button className="btn primary" disabled={busy || !!draft} title={draft ? 'Save first' : ''} onClick={() => run(() => post(`/marketing/${id}/submit`), 'Sent to the owner for approval').then(reload)}>Send for approval</button>}
        {c.status === 'pending_approval' && can('marketing.approve') && <button className="btn primary" disabled={!!draft} onClick={openPreview}>Review and approve</button>}
        {c.status === 'pending_approval' && !can('marketing.approve') && <span className="muted">Waiting for the owner to approve.</span>}
        {['approved', 'paused'].includes(c.status) && sends && can('campaign.control') && <button className="btn primary" onClick={() => setConfirm({ a: 'start', t: c.kind === 'social_post' ? 'Publish now?' : 'Start campaign?', x: c.kind === 'social_post' ? 'The approved post will be published to the selected pages.' : 'Sending starts within the allowed hours and skips anyone who may not be contacted.' })}><Icon name="play" />{c.kind === 'social_post' ? 'Publish' : c.status === 'paused' ? 'Resume' : 'Start'}</button>}
        {['running', 'scheduled'].includes(c.status) && can('campaign.control') && <button className="btn" onClick={() => run(() => post(`/marketing/${id}/pause`), 'Paused').then(reload)}><Icon name="pause" />Pause</button>}
        {['running', 'scheduled', 'paused'].includes(c.status) && can('campaign.control') && <button className="btn danger" onClick={() => setConfirm({ a: 'stop', t: 'Stop for good?', x: 'Nobody else will be contacted. This cannot be resumed.' })}><Icon name="stop" />Stop</button>}
        {['draft', 'rejected'].includes(c.status) && can('marketing.write') && <button className="btn ghost" onClick={() => setConfirm({ del: true, t: 'Delete this draft?', x: 'This cannot be undone.' })}>Delete draft</button>}
      </div>
      {preview && <ApprovalPreview id={id} p={preview} onClose={() => { setPreview(null); reload(); }} />}
      {confirm && <Confirm title={confirm.t} text={confirm.x} danger={confirm.a === 'stop' || confirm.del} onClose={() => setConfirm(null)}
        onConfirm={() => confirm.del ? run(() => del(`/marketing/${id}`), 'Draft deleted').then(() => nav('/marketing')) : run(() => post(`/marketing/${id}/${confirm.a}`), confirm.a === 'stop' ? 'Stopped' : 'Started').then(reload)} />}
    </>
  );
}

function ApprovalPreview({ id, p, onClose }) {
  const [run, busy] = useAction();
  const [note, setNote] = useState('');
  const v = p.preview;
  return (
    <Modal title="Review before approving" onClose={onClose} wide footer={<>
      <input className="in" style={{ flex: 1 }} placeholder="Reason for sending back (optional)" value={note} onChange={e => setNote(e.target.value)} />
      <button className="btn" disabled={busy} onClick={() => run(() => post(`/marketing/${id}/reject`, { note }), 'Sent back').then(onClose)}>Send back</button>
      <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/marketing/${id}/approve`, { hash: p.hash }), 'Approved').then(onClose)}>Approve exactly this</button></>}>
      {p.warnings.length > 0 && <div className="notice warn">{p.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
      <div><b>Final text</b><pre className="code" style={{ fontFamily: 'inherit', fontSize: '1em' }}>{v.text || '(empty)'}</pre></div>
      {v.templateSid && <div><b>WhatsApp template:</b> {v.templateSid}</div>}
      <div><b>Files:</b> {v.files.length ? v.files.map(f => f.filename).join(', ') : 'none'}</div>
      <div><b>Channels:</b> {v.channels.length ? v.channels.map(ch => ch === 'messenger' ? 'Facebook Page' : CHANNEL[ch] || ch).join(', ') : v.kind === 'sms_blast' ? 'SMS' : v.kind === 'whatsapp_blast' ? 'WhatsApp' : v.kind === 'call_campaign' ? 'Phone calls by Natalie' : v.kind === 'email_blast' ? 'Email' : '—'}</div>
      <div><b>When:</b> {v.scheduleAt ? dateTime(v.scheduleAt) : 'When you press Start'}{p.preview.sendingHours ? ` — only ${p.preview.sendingHours}` : ''}</div>
      {v.audienceSummary && <div><b>Audience:</b> {v.audienceSummary.matched} match, <b>{v.audienceSummary.eligible}</b> can be contacted.
        {Object.entries(v.audienceSummary.skipped).map(([r, n]) => <div key={r} className="small muted">{n} skipped: {r}</div>)}
        <div className="small muted">Examples: {v.audienceSummary.sample.map(s => `Lead ${s.lead_no} ${s.name || s.company || ''}`).join(', ')}</div></div>}
      <p className="small muted" style={{ margin: 0 }}>If anything changes after you approve, it goes back to draft and needs approval again.</p>
    </Modal>
  );
}
