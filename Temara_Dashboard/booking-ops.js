/**
 * Shared booking dashboard helpers — calendar events, status lanes,
 * daily CSV/print, gap cards, directory formatting.
 */
(function () {
  'use strict';

  const TIMEZONE = 'Africa/Casablanca';
  const STATUS_LANES = [
    { key: 'confirme', label: 'Confirmé', match: ['confirme'] },
    { key: 'en_salle', label: 'En salle', match: ['en_salle', 'en salle'] },
    { key: 'en_soin', label: 'En soin', match: ['en_soin', 'en soin'] },
    { key: 'termine', label: 'Terminé', match: ['termine'] },
  ];
  const STRIP_LANES = [
    { key: 'no_show', label: 'No-show', match: ['no-show', 'no_show', 'noshow'] },
    { key: 'annule', label: 'Annulé', match: ['annule'] },
    { key: 'en_attente', label: 'En attente', match: ['en_attente', 'en attente'] },
  ];
  const CAL_COLORS = {
    confirme: '#C89E66',
    en_attente: '#8C8C9A',
    en_salle: '#6EE7B7',
    en_soin: '#5B8DEF',
    termine: '#6B7280',
    no_show: '#E07A5F',
    annule: '#6B6B78',
  };

  function normalizeStatus(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’]/g, '')
      .replace(/[\s-]+/g, '_');
  }

  function statusKey(value) {
    const key = normalizeStatus(value);
    if (key.includes('salle')) return 'en_salle';
    if (key.includes('soin')) return 'en_soin';
    if (key.includes('attente')) return 'en_attente';
    if (key.includes('termin')) return 'termine';
    if (key.includes('no_show') || key.includes('noshow')) return 'no_show';
    if (key.includes('annul')) return 'annule';
    if (key.includes('confirm')) return 'confirme';
    return key || 'confirme';
  }

  function casablancaYmd(date = new Date()) {
    return date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  }

  function casablancaHm(value) {
    if (value == null || value === '') return '';
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: TIMEZONE,
    });
  }

  function formatDayLabel(value) {
    if (!value) return '—';
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return parsed.toLocaleDateString('fr-MA', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: TIMEZONE,
    });
  }

  function isUrgence(record) {
    return /urgence/i.test(String(record?.treatment_name || record?.treatment || ''));
  }

  function toCalendarEvent(record) {
    const start = record.starts_at || record.startTime || record.rawDate;
    if (!start) return null;
    const startDate = new Date(start);
    if (Number.isNaN(startDate.getTime())) return null;
    const duration = Math.max(1, Number(record.duration_min) || 30);
    const endDate = new Date(startDate.getTime() + duration * 60000);
    const key = statusKey(record.status);
    const name = record.patient_name || record.name || 'Patient';
    const motif = record.treatment_name || record.treatment || 'Consultation';
    return {
      id: String(record.id || record.cal_booking_uid || `${name}-${startDate.toISOString()}`),
      title: `${motif} — ${name}`,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      backgroundColor: CAL_COLORS[key] || CAL_COLORS.confirme,
      borderColor: 'transparent',
      textColor: '#111118',
      extendedProps: {
        status: record.status,
        statusKey: key,
        treatment: motif,
        phone: record.patient_phone || record.phone || '',
        bookingId: record.id,
      },
    };
  }

  function ymdFromView(info) {
    const start = info?.start || info?.view?.activeStart;
    const end = info?.end || info?.view?.activeEnd;
    if (!start || !end) return null;
    const from = casablancaYmd(start);
    const endDate = new Date(end.getTime() - 1);
    const to = casablancaYmd(endDate);
    return { from, to };
  }

  function laneForRecord(record) {
    const key = statusKey(record.status);
    if (STATUS_LANES.some((lane) => lane.key === key)) return key;
    if (STRIP_LANES.some((lane) => lane.key === key)) return key;
    return 'confirme';
  }

  function partitionStatusBoard(records, urgenceOnly) {
    const source = Array.isArray(records) ? records : [];
    const filterOn = typeof urgenceOnly === 'object' && urgenceOnly
      ? Boolean(urgenceOnly.urgencesOnly || urgenceOnly.urgenceOnly)
      : Boolean(urgenceOnly);
    const filtered = filterOn ? source.filter(isUrgence) : source;
    const buckets = {};
    [...STATUS_LANES, ...STRIP_LANES].forEach((lane) => {
      buckets[lane.key] = [];
    });
    filtered.forEach((record) => {
      const key = laneForRecord(record);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(record);
    });
    return buckets;
  }

  function escapeCsvCell(value) {
    const text = String(value ?? '');
    if (/[;"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function dailyReportRows(records) {
    return (Array.isArray(records) ? records : []).map((record) => [
      record.time || casablancaHm(record.starts_at || record.startTime || record.rawDate),
      record.patient_name || record.name || 'Non spécifié',
      record.patient_phone || record.phone || '',
      record.treatment_name || record.treatment || 'Consultation',
      record.status || 'Confirmé',
    ]);
  }

  function downloadDailyCsv(records, filename) {
    const header = ['Heure', 'Patient', 'Téléphone', 'Motif', 'Statut'];
    const rows = dailyReportRows(records);
    const csvLines = [header, ...rows].map((line) => line.map(escapeCsvCell).join(';'));
    const csvContent = `\uFEFF${csvLines.join('\r\n')}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename || `Rapport_Dentaflow_${casablancaYmd()}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    return rows.length;
  }

  function printDailyRoster(records, clinicName) {
    const rows = dailyReportRows(records);
    const title = (clinicName && typeof clinicName === 'object'
      ? clinicName.title
      : clinicName) || 'Clinique Dentaire Témara Mall';
    const dateLabel = new Date().toLocaleDateString('fr-MA', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: TIMEZONE,
    });
    const table = rows.length
      ? rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
      : '<tr><td colspan="5">Aucun rendez-vous aujourd\'hui</td></tr>';
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Planning du ${escapeHtml(dateLabel)}</title>
      <style>
        body { font-family: Inter, system-ui, sans-serif; color: #111; padding: 24px; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        p { color: #555; margin: 0 0 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { border-bottom: 1px solid #ddd; text-align: left; padding: 8px 6px; }
        th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
      </style></head><body>
      <h1>${escapeHtml(title)}</h1>
      <p>Planning du ${escapeHtml(dateLabel)}</p>
      <table><thead><tr><th>Heure</th><th>Patient</th><th>Téléphone</th><th>Motif</th><th>Statut</th></tr></thead>
      <tbody>${table}</tbody></table>
      </body></html>`;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    const cleanup = () => {
      setTimeout(() => frame.remove(), 500);
    };
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      cleanup();
    };
    setTimeout(() => {
      try {
        frame.contentWindow.print();
      } catch { /* ignore */ }
      cleanup();
    }, 400);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function occupancyLabel(occupancy) {
    const pct = Number(occupancy?.pct);
    if (!Number.isFinite(pct)) return '—';
    return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)} %`;
  }

  function rateLabel(rate) {
    if (rate == null || Number.isNaN(Number(rate))) return '—';
    const n = Number(rate);
    return `${n.toFixed(n % 1 === 0 ? 0 : 1)} %`;
  }

  window.DentaFlowBookingOps = {
    TIMEZONE,
    STATUS_LANES,
    STRIP_LANES,
    normalizeStatus,
    statusKey,
    casablancaYmd,
    casablancaHm,
    formatDayLabel,
    isUrgence,
    toCalendarEvent,
    ymdFromView,
    partitionStatusBoard,
    downloadDailyCsv,
    printDailyRoster,
    occupancyLabel,
    rateLabel,
    escapeHtml,
  };
})();
