// Central configuration. Secrets only come from the server environment, never from the browser.
const env = process.env;

function bool(v, d = false) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export const config = {
  appEnv: env.APP_ENV || 'development',          // development | test | staging | production
  port: Number(env.PORT || 8080),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/dscrm_dev?host=/tmp',
  // 32-byte key (hex or base64) used to encrypt provider credentials at rest.
  encryptionKey: env.APP_ENCRYPTION_KEY || '',
  sessionDays: Number(env.SESSION_DAYS || 14),
  // 'live' sends through providers; 'sandbox' records outbound messages/calls/posts without delivering them.
  // Staging and test always run sandbox regardless of this value.
  deliveryMode: env.DELIVERY_MODE || 'sandbox',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  uploadsDir: env.UPLOADS_DIR || './data/uploads',
  allowedSiteOrigins: (env.SITE_ORIGINS || 'https://dssunifoems.com,https://www.dssunifoems.com').split(',').map(s => s.trim()).filter(Boolean),
  runWorkerInProcess: bool(env.RUN_WORKER_IN_PROCESS, true),
  trustProxy: bool(env.TRUST_PROXY, true),
};

export function deliveryIsLive() {
  return config.deliveryMode === 'live' && config.appEnv === 'production';
}
