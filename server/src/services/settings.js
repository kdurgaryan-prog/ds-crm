// Business settings with safe defaults. Agent display names and IDs live here (one central place).
export const DEFAULT_SETTINGS = {
  timezone: 'America/Los_Angeles',
  company: { legalName: 'DS Systems LLC', website: 'https://dssunifoems.com' },
  links: {
    // Natalie never quotes prices; she points customers to these pages. Verified from Settings.
    quotePage: 'https://dssunifoems.com/pages/contact',
    contactPage: 'https://dssunifoems.com/pages/contact',
    checks: {},                       // { url: { ok, status, checkedAt } }
  },
  moq: { minQty: 20, rule: 'Same product type and color' },
  campaignHours: { start: '09:00', end: '17:00', timezone: 'America/Los_Angeles', days: [1, 2, 3, 4, 5] },
  calls: { recordCalls: false, recordingDisclosure: 'This call may be recorded for quality.', handoffNumber: '', ringTimeoutSec: 20 },
  agents: {
    natalie: {
      id: 'natalie', displayName: 'Natalie',
      enabled: true,             // master switch (kill switch sets false)
      autoReplyMessages: true,   // answers SMS/WhatsApp/social/webchat on her own
      answerCalls: true,         // answers inbound calls
      outboundCalls: false,      // outbound call campaigns (needs owner-approved campaign too)
      languages: ['en', 'hy', 'ru', 'es'],
    },
    arev: {
      id: 'arev', displayName: 'Arev',
      enabled: true,
      // CRM fields Arev may read. No phone numbers, no message bodies, no emails.
      dataScopes: ['industry', 'product_type', 'decoration', 'quantity', 'source', 'status', 'created_at', 'company'],
    },
  },
  quotes: { defaultTaxRate: 0.095, validDays: 14 },
};

export function mergeSettings(stored) {
  const out = structuredClone(DEFAULT_SETTINGS);
  const deep = (t, s) => {
    for (const [k, v] of Object.entries(s || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) deep(t[k], v);
      else t[k] = v;
    }
  };
  deep(out, stored);
  return out;
}

export async function getSettings(client, businessId) {
  const { rows } = await client.query('select settings from businesses where id = $1', [businessId]);
  return mergeSettings(rows[0]?.settings);
}

export async function patchSettings(client, businessId, patch) {
  const { rows } = await client.query('select settings from businesses where id = $1 for update', [businessId]);
  const merged = mergeSettings(rows[0]?.settings);
  const deep = (t, s) => {
    for (const [k, v] of Object.entries(s || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') deep(t[k], v);
      else t[k] = v;
    }
  };
  deep(merged, patch);
  await client.query('update businesses set settings = $2 where id = $1', [businessId, merged]);
  return merged;
}
