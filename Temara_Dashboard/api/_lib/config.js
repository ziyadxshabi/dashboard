/**
 * Centralized environment configuration for DentaFlow OS API routes.
 * Zero dependencies. CommonJS exports only.
 */

const DEFAULT_BASEROW_API_URL = 'https://api.baserow.io';
const DEFAULT_BOOKINGS_TABLE_ID = '1017856';
const DEFAULT_WAITLIST_TABLE_ID = '1039940';

const WEBHOOK_ALIASES = {
  dashboard: ['N8N_WEBHOOK_DASHBOARD'],
  roster: ['N8N_WEBHOOK_ROSTER'],
  waitlist: ['N8N_WEBHOOK_WAITLIST', 'N8N_WAITLIST_WEBHOOK'],
  update_status: ['N8N_WEBHOOK_UPDATE_STATUS'],
  fill_gap: ['N8N_WEBHOOK_FILL_GAP'],
  team_notes: ['N8N_WEBHOOK_TEAM_NOTES', 'N8N_WEBHOOK_GET_NOTES', 'N8N_WEBHOOK_POST_NOTE'],
  bulk_sms: ['N8N_WEBHOOK_BULK_SMS'],
  delay_alert: ['N8N_WEBHOOK_DELAY_ALERT'],
  lead_capture: ['N8N_WEBHOOK_LEAD_CAPTURE'],
  assistant: ['N8N_WEBHOOK_DASHBOARD_ASSISTANT', 'N8N_WEBHOOK_ASSISTANT_PROXY'],
  dashboard_assistant: ['N8N_WEBHOOK_DASHBOARD_ASSISTANT', 'N8N_WEBHOOK_ASSISTANT_PROXY'],
  base: ['N8N_WEBHOOK_BASE_URL'],
};

const OPTIONAL_WEBHOOK_KEYS = [
  'dashboard',
  'roster',
  'waitlist',
  'update_status',
  'fill_gap',
  'team_notes',
  'bulk_sms',
  'delay_alert',
  'lead_capture',
  'assistant',
];

function getEnv(name, defaultValue = null) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const trimmed = String(raw).trim();
  if (!trimmed) return defaultValue;
  return trimmed;
}

function stripTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function normalizeWebhookKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function envNamesForWebhook(key) {
  const normalized = normalizeWebhookKey(key);
  if (WEBHOOK_ALIASES[normalized]) return WEBHOOK_ALIASES[normalized];

  const compact = normalized.replace(/^n8n_webhook_/, '');
  if (WEBHOOK_ALIASES[compact]) return WEBHOOK_ALIASES[compact];

  const upper = String(key || '').trim().toUpperCase();
  if (upper.startsWith('N8N_')) return [upper];
  if (upper) return [`N8N_WEBHOOK_${upper}`];
  return [];
}

function getWebhookUrl(key, fallback = null) {
  const names = envNamesForWebhook(key);
  for (let i = 0; i < names.length; i++) {
    const candidate = stripTrailingSlashes(getEnv(names[i], ''));
    if (candidate && isHttpUrl(candidate)) return candidate;
  }
  if (fallback && isHttpUrl(stripTrailingSlashes(fallback))) {
    return stripTrailingSlashes(fallback);
  }
  return fallback;
}

function getBaserowConfig() {
  const apiUrl = stripTrailingSlashes(getEnv('BASEROW_API_URL', DEFAULT_BASEROW_API_URL))
    || DEFAULT_BASEROW_API_URL;
  return {
    apiUrl,
    token: getEnv('BASEROW_API_TOKEN', getEnv('BASEROW_TOKEN', '')) || '',
    tableId: getEnv('BASEROW_TABLE_ID', DEFAULT_BOOKINGS_TABLE_ID) || DEFAULT_BOOKINGS_TABLE_ID,
    waitlistTableId: getEnv('BASEROW_WAITLIST_TABLE_ID', DEFAULT_WAITLIST_TABLE_ID) || DEFAULT_WAITLIST_TABLE_ID,
    leadsTableId: getEnv('BASEROW_LEADS_TABLE_ID', '') || '',
  };
}

function getRedisConfig() {
  return {
    url: getEnv('UPSTASH_REDIS_REST_URL', getEnv('REDIS_CONNECTION_URL', '')) || '',
    token: getEnv('UPSTASH_REDIS_REST_TOKEN', getEnv('REDIS_REST_TOKEN', '')) || '',
  };
}

function validateEnv() {
  const missing = [];
  const warnings = [];

  if (!getEnv('JWT_SECRET')) missing.push('JWT_SECRET');
  if (!getEnv('DOCTOR_PASSWORD_HASH')) missing.push('DOCTOR_PASSWORD_HASH');
  if (!getEnv('ASSISTANT_PASSWORD_HASH')) missing.push('ASSISTANT_PASSWORD_HASH');

  const agencyAuth = getEnv('N8N_AUTH_KEY')
    || getEnv('DASHBOARD_AUTH_KEY')
    || getEnv('N8N_AGENCY_AUTH_KEY');
  if (!agencyAuth) {
    missing.push('N8N_AUTH_KEY|DASHBOARD_AUTH_KEY|N8N_AGENCY_AUTH_KEY');
  }

  const redis = getRedisConfig();
  if (!redis.url || !redis.token) {
    warnings.push('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (cache and login rate-limit persistence)');
  }

  const baserow = getBaserowConfig();
  if (!baserow.token) {
    warnings.push('BASEROW_API_TOKEN (roster and waitlist)');
  }

  OPTIONAL_WEBHOOK_KEYS.forEach((key) => {
    if (!getWebhookUrl(key)) {
      warnings.push(`webhook:${key}`);
    }
  });

  const ok = missing.length === 0;
  const summary = ok
    ? `Environment ready (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
    : `Environment incomplete: ${missing.length} required variable${missing.length === 1 ? '' : 's'} missing`;

  return { ok, missing, warnings, summary };
}

module.exports = {
  getEnv,
  getWebhookUrl,
  getBaserowConfig,
  getRedisConfig,
  validateEnv,
};
