// Website chat + quote form widget for the Shopify theme. One <script> tag:
// <script src="https://crm.example.com/widget.js" data-key="PUBLIC_KEY" defer></script>
// Add data-quote-form="#ds-quote" to also render the quote form inside an element with that id.
export function widgetScript(base) {
  return `(()=>{if(window.__dsWidget)return;window.__dsWidget=1;
const s=document.currentScript;const KEY=s.dataset.key;const API=${JSON.stringify(base)}+'/api/public/'+KEY;
const C=s.dataset.color||'#1f4fd1';const store={get:k=>{try{return JSON.parse(localStorage.getItem('ds_'+k))}catch{return null}},set:(k,v)=>{try{localStorage.setItem('ds_'+k,JSON.stringify(v))}catch{}}};
const css=\`.dsw-b{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:\${C};color:#fff;border:0;border-radius:28px;padding:13px 18px;font:600 15px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer}
.dsw-p{position:fixed;right:18px;bottom:78px;z-index:2147483000;width:min(360px,calc(100vw - 24px));height:min(520px,calc(100vh - 110px));background:#fff;color:#1d2433;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;font:15px/1.45 system-ui}
.dsw-p.o{display:flex}.dsw-h{background:\${C};color:#fff;padding:12px 14px;font-weight:600;display:flex;justify-content:space-between}.dsw-h small{font-weight:400;opacity:.85;display:block}
.dsw-m{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f6f7f9}.dsw-x{max-width:82%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.dsw-in{align-self:flex-end;background:\${C};color:#fff}.dsw-out{align-self:flex-start;background:#fff;border:1px solid #e3e6ea}
.dsw-f{display:flex;gap:6px;padding:10px;border-top:1px solid #e3e6ea}.dsw-f textarea{flex:1;resize:none;border:1px solid #cfd4da;border-radius:8px;padding:8px;font:inherit;height:42px}
.dsw-f button{background:\${C};color:#fff;border:0;border-radius:8px;padding:0 14px;font-weight:600;cursor:pointer}.dsw-c{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}
.dsq{display:grid;gap:10px;max-width:560px;font:15px system-ui}.dsq label{display:grid;gap:4px;font-weight:600}.dsq input,.dsq select,.dsq textarea{font:inherit;padding:9px;border:1px solid #cfd4da;border-radius:8px}
.dsq button{background:\${C};color:#fff;border:0;border-radius:8px;padding:12px;font-weight:700;cursor:pointer}.dsq .ok{color:#067647;font-weight:600}.dsq .err{color:#b42318}.dsq .hp{position:absolute;left:-9999px}\`;
const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
const el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.textContent=h;return e};
async function sess(){let v=store.get('v');if(v)return v;const r=await fetch(API+'/chat/session',{method:'POST'});v=await r.json();store.set('v',v);return v}
let last=null,poll=null,seen=new Set();
const btn=el('button','dsw-b','Chat with us');const p=el('div','dsw-p');
const h=el('div','dsw-h');const ht=el('div',null,'DS Systems');const sub=el('small',null,'Custom uniforms & apparel');ht.appendChild(sub);const x=el('button','dsw-c','×');x.setAttribute('aria-label','Close');h.append(ht,x);
const m=el('div','dsw-m');m.setAttribute('aria-live','polite');const f=el('form','dsw-f');const ta=el('textarea');ta.placeholder='Type your message…';ta.setAttribute('aria-label','Message');const sb=el('button',null,'Send');f.append(ta,sb);p.append(h,m,f);
function add(t,dir){const b=el('div','dsw-x '+(dir==='in'?'dsw-in':'dsw-out'),t);m.appendChild(b);m.scrollTop=m.scrollHeight}
async function load(){const v=await sess();const q=new URLSearchParams({visitorId:v.visitorId,token:v.token});if(last)q.set('after',last);
 const r=await fetch(API+'/chat/messages?'+q);if(!r.ok)return;const j=await r.json();for(const x of j.messages){if(seen.has(x.id))continue;seen.add(x.id);add(x.body,x.direction);last=x.created_at}}
btn.onclick=async()=>{p.classList.toggle('o');if(p.classList.contains('o')){const v=await sess();if(!m.childNodes.length)add(v.greeting,'out');sub.textContent=v.agentName+' · AI assistant';await load();clearInterval(poll);poll=setInterval(load,3000);ta.focus()}else clearInterval(poll)};
x.onclick=()=>{p.classList.remove('o');clearInterval(poll)};
f.onsubmit=async e=>{e.preventDefault();const t=ta.value.trim();if(!t)return;ta.value='';const v=await sess();
 const r=await fetch(API+'/chat/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visitorId:v.visitorId,token:v.token,text:t})});
 if(!r.ok){add('Sorry, your message could not be sent. Please call or text us.','out');return}await load()};
ta.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit()}};
if(s.dataset.chat!=='off'){document.body.append(btn,p)}
const target=s.dataset.quoteForm&&document.querySelector(s.dataset.quoteForm);
if(target){const fm=el('form','dsq');fm.innerHTML='<label>Your name*<input name="name" required maxlength="120"></label><label>Company<input name="company" maxlength="160"></label><label>Phone*<input name="phone" type="tel" required></label><label>Email (optional)<input name="email" type="email"></label><label>What do you need?<select name="product_type"><option value="">Choose…</option><option>T-shirts</option><option>Polos</option><option>Hoodies</option><option>Hats</option><option>Workwear / safety</option><option>Other</option></select></label><label>Quantity<input name="quantity" type="number" min="1"></label><label>Decoration<select name="decoration"><option value="">Choose…</option><option>DTF printing</option><option>Embroidery</option><option>Screen printing</option><option>Not sure</option></select></label><label>Needed by<input name="deadline" type="date"></label><label>Details<textarea name="message" rows="3"></textarea></label><label style="font-weight:400;display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="sms_consent" value="true"> I agree to receive marketing texts from DS Systems. Msg &amp; data rates may apply. Reply STOP to opt out.</label><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button>Request a quote</button><div class="msg" role="status"></div>';
 fm.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(fm));for(const k in d)if(d[k]==='')delete d[k];const out=fm.querySelector('.msg');out.className='msg';out.textContent='Sending…';
  try{const r=await fetch(API+'/forms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...d,form:'quote'})});const j=await r.json();
  if(r.ok){fm.reset();out.className='msg ok';out.textContent='Thanks! We received your request and will reach out soon.'}else{out.className='msg err';out.textContent=j.error||'Please check the form.'}}catch{out.className='msg err';out.textContent='Network error. Please try again or call us.'}};
 target.appendChild(fm)}
})();`;
}
