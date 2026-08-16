// Input: Baserow Bookings rows → KPI object (same shape as former Sheets output)

function fieldVal(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.map(fieldVal).filter(Boolean).join(' ');
    if (v.value != null) return fieldVal(v.value);
    if (v.name != null) return String(v.name);
    return '';
  }
  return v;
}

function casablancaYmd(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
}

function casablancaHour(d) {
  return d.toLocaleString('en-GB', {
    timeZone: 'Africa/Casablanca',
    hour: '2-digit',
    hour12: false,
  }).padStart(2, '0');
}

function parseApptDate(dateVal) {
  if (!dateVal) return null;
  const dateStr = String(fieldVal(dateVal));
  if (!dateStr) return null;
  if (dateStr.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const d = new Date(dateStr);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parts = dateStr.split(' ')[0].split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    const timePart = (dateStr.split(' ')[1] || '00:00').trim();
    const isoTime = timePart.length === 5 ? `${timePart}:00` : timePart;
    const d = new Date(`${year}-${month}-${day}T${isoTime}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

const today = casablancaYmd(new Date());
const rows = $input.all().map((item) => item.json);

const todayAppts = rows.filter((r) => {
  const d = parseApptDate(r['Date & Heure du RDV'] || r.Date || r.date);
  if (!d) return false;
  return casablancaYmd(d) === today;
});

function statusOf(r) {
  return String(fieldVal(r['Statut du RDV'] || r.status || r.Statut)).trim();
}

function isNoShow(status) {
  const s = status.toLowerCase().replace(/\s/g, '');
  return s === 'no-show' || s === 'noshow';
}

const kpis = {
  patients_today: todayAppts.length,
  no_shows: todayAppts.filter((r) => isNoShow(statusOf(r))).length,
  revenue_today: todayAppts.reduce((sum, r) => {
    const amount = fieldVal(r['Montant (MAD)'] || r.Montant || r.montant || r.amount || 0);
    const num = Number(String(amount).replace(/\s/g, '').replace(',', '.'));
    return sum + (Number.isFinite(num) ? num : 0);
  }, 0),
  new_patients: todayAppts.filter((r) => {
    const isNew = fieldVal(r['Nouveau Patient ?'] || r['Nouveau Patient'] || r.nouveau);
    const val = String(isNew).trim().toLowerCase();
    return val === 'oui' || val === 'yes' || val === 'true' || val === '1';
  }).length,
  accepted_plans: todayAppts.filter((r) => {
    const status = statusOf(r);
    return status === 'Confirmé' || status.toLowerCase() === 'confirmed';
  }).length,
  pending_plans: todayAppts.filter((r) => {
    const status = statusOf(r);
    return status === 'En attente' || status.toLowerCase() === 'pending';
  }).length,
};

for (let h = 8; h <= 18; h++) {
  const hourStr = String(h).padStart(2, '0');
  kpis[`hour_${hourStr}`] = todayAppts.filter((r) => {
    const d = parseApptDate(r['Date & Heure du RDV'] || r.Date || r.date);
    if (!d) return false;
    return casablancaHour(d) === hourStr;
  }).length;
}

const NUMERIC_METRICS = [
  'patients_today', 'no_shows', 'revenue_today', 'new_patients',
  'accepted_plans', 'pending_plans',
  'hour_08', 'hour_09', 'hour_10', 'hour_11', 'hour_12',
  'hour_13', 'hour_14', 'hour_15', 'hour_16', 'hour_17', 'hour_18',
];
const errors = [];
for (const m of NUMERIC_METRICS) {
  if (!(m in kpis) || !Number.isFinite(Number(kpis[m]))) {
    kpis[m] = 0;
    errors.push(`Missing metric: '${m}' — defaulted to 0`);
  }
}

const fetchedAt = new Date().toLocaleString('fr-MA', {
  timeZone: 'Africa/Casablanca',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

return (async () => {
  const cachePayload = {
    ...kpis,
    last_updated: fetchedAt,
    schema_warnings: errors,
  };

  async function redisSetEx(key, value, ttlSec) {
    const base = String($vars['REDIS_CONNECTION_URL'] ?? $env['REDIS_CONNECTION_URL'] ?? '').replace(/\/+$/, '');
    const token = String($vars['REDIS_REST_TOKEN'] ?? $env['REDIS_REST_TOKEN'] ?? '').trim();
    if (!base) throw new Error('CRITICAL: REDIS_CONNECTION_URL missing from environment');
    const h = token ? { Authorization: `Bearer ${token}` } : {};
    const encKey = encodeURIComponent(key);
    const encVal = encodeURIComponent(value);
    const res = await fetch(`${base}/set/${encKey}/${encVal}?EX=${ttlSec}`, { method: 'POST', headers: h });
    if (!res.ok) throw new Error(`REDIS_HTTP_FAIL: set ${res.status}`);
  }

  await redisSetEx('dashboard:kpi:payload', JSON.stringify(cachePayload), 60);

  return [{
    json: {
      ...kpis,
      last_updated: fetchedAt,
      _fromCache: false,
      schema_warnings: errors,
    },
  }];
})();
