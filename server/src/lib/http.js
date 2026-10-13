// HTTP helpers: typed errors with plain-English recovery hints, validation, async wrapper.
export class AppError extends Error {
  constructor(status, message, { code, hint, details } = {}) {
    super(message);
    this.status = status; this.code = code; this.hint = hint; this.details = details;
  }
}
export const badRequest = (m, o) => new AppError(400, m, { code: 'bad_request', ...o });
export const forbidden = (m = 'You do not have permission to do this.', o) => new AppError(403, m, { code: 'forbidden', hint: 'Ask the owner or an admin to change your role.', ...o });
export const notFound = (m = 'Not found.') => new AppError(404, m, { code: 'not_found' });
export const conflict = (m, o) => new AppError(409, m, { code: 'conflict', ...o });

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'Some fields need attention.', { code: 'validation', details: issues, hint: 'Fix the highlighted fields and try again. Your other entries are kept.' });
  }
  return r.data;
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code, hint: err.hint, details: err.details });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.', hint: 'Use a file under the size limit.' });
  if (err?.code === '23505') return res.status(409).json({ error: 'This record already exists.', code: 'duplicate', hint: 'Search for the existing record instead of creating a new one.' });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'Something went wrong on the server.', code: 'server_error', hint: 'Your entries were not lost. Try again in a moment; if it keeps happening, check Settings → System health.' });
}
