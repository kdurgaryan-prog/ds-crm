import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, withBiz } from './db.js';
import { errorHandler, notFound } from './lib/http.js';
import authRoutes, { requireAuth, csrfGuard, requirePerm } from './routes/auth.js';
import contacts from './routes/contacts.js';
import phoneTexts from './routes/phonetexts.js';
import inbox from './routes/inbox.js';
import calls from './routes/calls.js';
import tasks from './routes/tasks.js';
import { quotes, orders, priceList } from './routes/sales.js';
import marketing from './routes/marketing.js';
import agents from './routes/agents.js';
import { dashboard, reports } from './routes/dashboard.js';
import settings from './routes/settings.js';
import publicRoutes from './routes/public.js';
import twilioWebhooks from './integrations/twilio-webhooks.js';
import metaWebhooks from './integrations/meta-webhooks.js';
import { storagePath, verifyMediaSig } from './services/files.js';
import { widgetScript } from './widget.js';
// job handlers register on import
import './agents/natalie.js';
import './integrations/voice-relay.js';
import './services/marketing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'https://*.twilio.com', 'wss://*.twilio.com'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: false,
  }));
  app.use(cookieParser());

  app.get('/healthz', async (_req, res) => {
    try { await pool.query('select 1'); res.json({ ok: true, env: config.appEnv }); } catch { res.status(503).json({ ok: false }); }
  });

  // provider webhooks (own body parsers + signature verification)
  app.use('/webhooks/twilio', twilioWebhooks);
  app.use('/webhooks/meta', metaWebhooks);
  // website (Shopify) public endpoints + widget script
  app.use('/api/public', publicRoutes);
  app.get('/widget.js', (_req, res) => res.type('application/javascript').set('cache-control', 'public, max-age=300').send(widgetScript(config.publicUrl)));

  // signed media for Twilio/Meta to fetch outbound attachments
  app.get('/media/:biz/:fileId', async (req, res) => {
    if (!verifyMediaSig(req.params.biz, req.params.fileId, req.query.exp, req.query.sig)) return res.sendStatus(403);
    const f = await withBiz(req.params.biz, async c => (await c.query('select storage_key, mime, filename from files where id = $1', [req.params.fileId])).rows[0]);
    if (!f) return res.sendStatus(404);
    res.type(f.mime || 'application/octet-stream').sendFile(storagePath(f.storage_key));
  });

  app.use('/api', express.json({ limit: '2mb' }));
  app.use('/api/auth', csrfGuard, authRoutes);
  const api = express.Router();
  api.use(requireAuth, csrfGuard);
  api.use('/dashboard', dashboard);
  api.use('/reports', reports);
  api.use('/contacts', contacts);
  api.use('/phone-texts', phoneTexts);
  api.use('/inbox', inbox);
  api.use('/calls', calls);
  api.use('/tasks', tasks);
  api.use('/quotes', quotes);
  api.use('/orders', orders);
  api.use('/price-list', priceList);
  api.use('/marketing', marketing);
  api.use('/agents', agents);
  api.use('/settings', settings);
  api.get('/files/:id', requirePerm('contacts.read'), async (req, res) => {
    const f = await withBiz(req.ctx.businessId, async c => (await c.query('select * from files where id = $1', [req.params.id])).rows[0]);
    if (!f) throw notFound('File not found.');
    const inline = /^image\/|application\/pdf/.test(f.mime || '') && req.query.download !== '1';
    res.set('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`);
    res.set('x-content-type-options', 'nosniff');
    if (f.mime === 'image/svg+xml') res.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'"); // SVG cannot run scripts
    res.type(f.mime || 'application/octet-stream').sendFile(storagePath(f.storage_key));
  });
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(notFound('Unknown API route.')));

  // web app
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes('/assets/')) res.set('cache-control', 'public, max-age=31536000, immutable'); } }));
    app.get(/^\/(?!api|webhooks|media|ws).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
