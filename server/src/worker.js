// Optional separate worker process (set RUN_WORKER_IN_PROCESS=false on the web process when using it).
import './agents/natalie.js';
import './integrations/voice-relay.js';
import './services/marketing.js';
import './routes/settings.js';
import { ensureEmailPolling } from './integrations/email.js';
import { startWorker } from './jobs/queue.js';
import { migrate } from './migrate.js';

await migrate({ log: () => {} });
await ensureEmailPolling();
startWorker({ intervalMs: 1000 });
console.log('[worker] running');
