// API client. Errors carry the server's plain-English message, hint and field details.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status; this.hint = body?.hint; this.code = body?.code; this.details = body?.details; this.body = body;
  }
  fieldErrors() { return Object.fromEntries((this.details || []).map(d => [d.field, d.message])); }
}

let onUnauthenticated = () => {};
export function setUnauthenticatedHandler(fn) { onUnauthenticated = fn; }

export async function api(path, { method = 'GET', body, form, headers = {}, signal } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'x-requested-with': 'dscrm', ...headers }, signal };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(`/api${path}`, opts); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, { error: 'Cannot reach the server.', hint: 'Check your internet connection. Nothing was changed.' });
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthenticated();
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body) => api(p, { method: 'POST', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = p => api(p, { method: 'DELETE' });

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
