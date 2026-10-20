import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { attachRelay } from './integrations/voice-relay.js';
import { startWorker } from './jobs/queue.js';
import { pool } from './db.js';

if (config.appEnv === 'production') {
  const missing = ['APP_ENCRYPTION_KEY', 'DATABASE_URL', 'PUBLIC_URL'].filter(k => !process.env[k]);
  if (missing.length) { console.error(`Missing required environment variables: ${missing.join(', ')}`); process.exit(1); }
}

await migrate({ log: m => console.log('[migrate]', m) });
{
  const { rows } = await pool.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
  if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
    const msg = 'The database user is a superuser or can bypass row-level security, so businesses would not be kept apart. Connect with a normal database user (see README).';
    if (config.appEnv === 'production' && process.env.ALLOW_PRIVILEGED_DB !== 'true') { console.error(`[ds-crm] ${msg}`); process.exit(1); }
    console.warn(`[ds-crm] WARNING: ${msg}`);
  }
}
const app = createApp();
const server = http.createServer(app);
attachRelay(server);
if (config.runWorkerInProcess) { const { ensureEmailPolling } = await import('./integrations/email.js'); await ensureEmailPolling().catch(e => console.error('[email] polling setup', e.message)); startWorker(); }
server.listen(config.port, () => console.log(`[ds-crm] ${config.appEnv} on :${config.port} (delivery: ${config.deliveryMode === 'live' && config.appEnv === 'production' ? 'live' : 'sandbox'})`));

const shutdown = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
