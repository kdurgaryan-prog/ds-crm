// File storage on local disk (mount a persistent volume). Signed, expiring URLs let Twilio/Meta fetch MMS/WhatsApp media.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const ALLOWED = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf|application\/postscript|application\/illustrator|image\/vnd\.adobe\.photoshop|application\/zip|text\/plain|video\/mp4|audio\/(mpeg|wav|x-wav))$/;
export const MAX_UPLOAD = 25 * 1024 * 1024;

export function isAllowedMime(m) { return ALLOWED.test(m || ''); }

export function storagePath(key) {
  const p = path.resolve(config.uploadsDir, key);
  if (!p.startsWith(path.resolve(config.uploadsDir))) throw new Error('bad path');
  return p;
}

export function saveBuffer(businessId, buf, filename) {
  const ext = path.extname(filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const key = `${businessId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ext}`;
  const p = storagePath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return key;
}

function mediaSecret() { return crypto.createHash('sha256').update('media:' + (config.encryptionKey || 'dev-only')).digest(); }

export function signedMediaUrl(businessId, fileId, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', mediaSecret()).update(`${businessId}:${fileId}:${exp}`).digest('base64url');
  return `${config.publicUrl}/media/${businessId}/${fileId}?exp=${exp}&sig=${sig}`;
}

export function verifyMediaSig(businessId, fileId, exp, sig) {
  if (!exp || Number(exp) < Date.now() / 1000) return false;
  const want = crypto.createHmac('sha256', mediaSecret()).update(`${businessId}:${fileId}:${exp}`).digest('base64url');
  return want.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(sig)));
}
