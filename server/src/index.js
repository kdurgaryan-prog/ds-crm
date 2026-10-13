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
const app = createApp();
const server = http.createServer(app);
attachRelay(server);
if (config.runWorkerInProcess) startWorker();
server.listen(config.port, () => console.log(`[ds-crm] ${config.appEnv} on :${config.port} (delivery: ${config.deliveryMode === 'live' && config.appEnv === 'production' ? 'live' : 'sandbox'})`));

const shutdown = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
