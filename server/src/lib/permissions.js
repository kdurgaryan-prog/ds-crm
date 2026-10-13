// Role → permissions. Kept in one place so the UI and API agree.
const P = {
  'contacts.read': ['owner', 'admin', 'sales', 'marketing', 'viewer'],
  'contacts.write': ['owner', 'admin', 'sales'],
  'contacts.merge': ['owner', 'admin', 'sales'],
  'contacts.delete': ['owner', 'admin'],
  'contacts.export': ['owner', 'admin'],
  'contacts.import': ['owner', 'admin'],
  'inbox.read': ['owner', 'admin', 'sales', 'viewer'],
  'inbox.reply': ['owner', 'admin', 'sales'],
  'calls.read': ['owner', 'admin', 'sales', 'viewer'],
  'calls.make': ['owner', 'admin', 'sales'],
  'tasks.write': ['owner', 'admin', 'sales', 'marketing'],
  'quotes.read': ['owner', 'admin', 'sales', 'viewer'],
  'quotes.write': ['owner', 'admin', 'sales'],
  'quotes.approve': ['owner', 'admin'],
  'orders.read': ['owner', 'admin', 'sales', 'viewer'],
  'orders.write': ['owner', 'admin', 'sales'],
  'pricelist.write': ['owner', 'admin'],
  'marketing.read': ['owner', 'admin', 'marketing', 'viewer'],
  'marketing.write': ['owner', 'admin', 'marketing'],
  'marketing.approve': ['owner'],            // publishing / blasts / call campaigns need the owner
  'campaign.control': ['owner', 'admin'],     // pause/stop a running campaign (start needs owner approval first)
  'reports.read': ['owner', 'admin', 'sales', 'marketing', 'viewer'],
  'agents.read': ['owner', 'admin', 'sales', 'marketing', 'viewer'],
  'agents.control': ['owner'],               // kill switches & agent settings
  'settings.read': ['owner', 'admin'],
  'settings.write': ['owner', 'admin'],
  'integrations.write': ['owner', 'admin'],
  'users.manage': ['owner', 'admin'],
  'audit.read': ['owner', 'admin'],
  'backup.manage': ['owner'],
  'jobs.manage': ['owner', 'admin'],
};

export const ROLES = ['owner', 'admin', 'sales', 'marketing', 'viewer'];
export function can(role, perm) { return !!P[perm]?.includes(role); }
export function permissionsFor(role) { return Object.keys(P).filter(p => P[p].includes(role)); }
