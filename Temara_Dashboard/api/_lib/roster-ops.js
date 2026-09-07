/**
 * Assistant floor ops — catalog, visit/walk-in, blocks, holds, recalls.
 * Used by GET/POST /api/roster (no extra Vercel function file).
 */
'use strict';

const { query } = require('./db');
const { listTreatments, resolveTreatment } = require('./treatments');
const {
  casablancaDateTimeParts,
  compactPhone,
  createApiError,
  sanitizeString,
} = require('./validation');
const { createCalBusyBooking, cancelCalBusyBooking, attachCalUid } = require('./cal-busy');
const { ensurePatient } = require('./patients');

const CLINIC_OPEN = '08:00';
const CLINIC_CLOSE = '19:00';
const SLOT_STEP_MIN = 5;
const DUPLICATE_LOOKBACK_DAYS = 90;
const DEFAULT_BLOCK_MIN = 60;
const DEFAULT_HOLD_MIN = 30;
const BLOCK_LABELS = Object.freeze({
  dejeuner: 'Déjeuner',
  'déjeuner': 'Déjeuner',
  lunch: 'Déjeuner',
  labo: 'Labo',
  absent: 'Absent',
  off: 'Absent',
  indisponible: 'Indisponible',
});

const BUSY_TODAY_SQL = `
  SELECT id, starts_at, duration_min, buffer_min, booking_kind, status::text AS status
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date = $2::date
    AND status NOT IN ('Annule', 'No-show')
  ORDER BY starts_at ASC
`;

const INSERT_BOOKING_SQL = `
  INSERT INTO bookings (
    clinic_id,
    patient_name,
    patient_phone,
    treatment_name,
    status,
    starts_at,
    duration_min,
    buffer_min,
    booking_kind,
    notes,
    patient_id,
    staff_id,
    charge_mad,
    updated_at
  )
  VALUES (
    $1, $2, $3, $4, $5::appointment_status, $6, $7, $8, $9, $10, $11, $12, $13, NOW()
  )
  RETURNING
    id,
    cal_booking_uid,
    patient_name,
    patient_phone,
    treatment_name,
    status::text AS status,
    starts_at,
    duration_min,
    buffer_min,
    booking_kind,
    care_started_at,
    cancel_reason,
    notes,
    patient_id,
    staff_id,
    charge_mad
`;

const DUPLICATE_SQL = `
  SELECT id, patient_name, patient_phone, treatment_name, starts_at, status::text AS status
  FROM bookings
  WHERE clinic_id = $1
    AND COALESCE(booking_kind, 'visit') = 'visit'
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
      >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - ${DUPLICATE_LOOKBACK_DAYS}
    AND (
      regexp_replace(COALESCE(patient_phone, ''), '[\\s.\\-]', '', 'g') = $2
      OR lower(patient_name) = lower($3)
    )
  ORDER BY starts_at DESC
  LIMIT 8
`;

function overlapError(message) {
  return createApiError(
    'OVERLAP',
    message || 'Ce créneau chevauche un rendez-vous, un blocage ou le tampon.'
  );
}

function minutesBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function roundUpToStep(date, stepMin = SLOT_STEP_MIN) {
  const ms = stepMin * 60000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}

function casablancaWallDate(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+01:00`);
}

function formatHm(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Casablanca',
  });
}

async function clinicBufferMin(clinicId) {
  const result = await query('SELECT buffer_min FROM clinics WHERE id = $1 LIMIT 1', [clinicId]);
  const value = Number(result.rows[0]?.buffer_min);
  return Number.isFinite(value) && value >= 0 ? value : 10;
}

function busyEnd(row) {
  const start = row.starts_at instanceof Date ? row.starts_at : new Date(row.starts_at);
  const duration = Math.max(1, Number(row.duration_min) || 30);
  const buffer = Math.max(0, Number(row.buffer_min) || 10);
  return addMinutes(start, duration + buffer);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function findNextGap({ now, dateIso, durationMin, bufferMin, busyRows, fromTime }) {
  const open = casablancaWallDate(dateIso, CLINIC_OPEN);
  const close = casablancaWallDate(dateIso, CLINIC_CLOSE);
  const needed = Math.max(1, durationMin) + Math.max(0, bufferMin);
  let cursor = fromTime
    ? casablancaWallDate(dateIso, fromTime)
    : roundUpToStep(now > open ? now : open);
  if (cursor < open) cursor = open;
  cursor = roundUpToStep(cursor);

  const intervals = (busyRows || []).map((row) => {
    const start = row.starts_at instanceof Date ? row.starts_at : new Date(row.starts_at);
    return { start, end: busyEnd(row) };
  });

  while (addMinutes(cursor, needed) <= close) {
    const end = addMinutes(cursor, needed);
    const blocked = intervals.some((interval) => rangesOverlap(cursor, end, interval.start, interval.end));
    if (!blocked) {
      return { startsAt: cursor, endsAt: addMinutes(cursor, durationMin), time: formatHm(cursor), date: dateIso };
    }
    cursor = addMinutes(cursor, SLOT_STEP_MIN);
  }
  return null;
}

async function loadBusyForDate(clinicId, dateIso) {
  const result = await query(BUSY_TODAY_SQL, [clinicId, dateIso]);
  return result.rows || [];
}

async function findDuplicateMatches(clinicId, { phone, name }) {
  const compact = compactPhone(phone);
  if (!compact && !name) return [];
  const result = await query(DUPLICATE_SQL, [clinicId, compact || '__none__', name || '__none__']);
  return result.rows || [];
}

function blockDisplayName(label) {
  const raw = sanitizeString(label, 80);
  if (!raw) return 'Indisponible';
  const mapped = BLOCK_LABELS[raw.toLowerCase()];
  return mapped || raw;
}

async function createBookingRow(clinicId, fields) {
  const bufferMin = fields.bufferMin != null ? fields.bufferMin : await clinicBufferMin(clinicId);
  let patientId = fields.patientId || null;
  if (!patientId && fields.patientPhone) {
    const patient = await ensurePatient(clinicId, {
      name: fields.patientName,
      phone: fields.patientPhone,
    });
    patientId = patient?.id || null;
  }
  const result = await query(INSERT_BOOKING_SQL, [
    clinicId,
    fields.patientName,
    fields.patientPhone ?? '',
    fields.treatmentName || null,
    fields.status,
    fields.startsAt,
    fields.durationMin,
    bufferMin,
    fields.kind,
    fields.notes || null,
    patientId,
    fields.staffId || null,
    fields.chargeMad == null ? null : fields.chargeMad,
  ]);
  return result.rows[0];
}

async function handleCatalog(res, session) {
  const bufferMin = await clinicBufferMin(session.clinic_id);
  const today = casablancaDateTimeParts();
  const busy = await loadBusyForDate(session.clinic_id, today.date);
  const consultation = resolveTreatment('Consultation');
  const durationMin = consultation?.duration_min || 20;
  const now = new Date();
  const nextFreeSlot = findNextGap({
    now,
    dateIso: today.date,
    durationMin,
    bufferMin,
    busyRows: busy,
  });
  return res.status(200).json({
    ok: true,
    data: {
      treatments: listTreatments(),
      buffer_min: bufferMin,
      nextFreeSlot,
    },
  });
}

async function handleRecallsGet(res, session) {
  const result = await query(
    `SELECT id, patient_name, patient_phone, due_on, treatment_name, source_booking_id, status, created_at
     FROM recalls
     WHERE clinic_id = $1
       AND status = 'open'
       AND due_on <= (NOW() AT TIME ZONE 'Africa/Casablanca')::date
     ORDER BY due_on ASC, created_at ASC
     LIMIT 40`,
    [session.clinic_id]
  );
  return res.status(200).json({ ok: true, data: result.rows || [] });
}

async function handleRecallCreate(req, res, session) {
  if (session.role !== 'assistant') {
    return res.status(403).json(createApiError('FORBIDDEN', 'Seul le cabinet (assistante) pose un rappel.'));
  }
  const body = req.body ?? {};
  const bookingId = String(body.bookingId ?? body.booking_id ?? body.id ?? '').trim();
  let patientName = sanitizeString(body.patientName ?? body.patient_name, 100);
  let patientPhone = compactPhone(body.patientPhone ?? body.patient_phone ?? body.phone ?? '');
  let treatmentName = sanitizeString(body.treatmentName ?? body.treatment_name ?? body.treatment, 80);
  let dueOn = String(body.dueOn ?? body.due_on ?? '').trim();

  if (bookingId) {
    const found = await query(
      `SELECT patient_name, patient_phone, treatment_name
       FROM bookings
       WHERE clinic_id = $1 AND id::text = $2
       LIMIT 1`,
      [session.clinic_id, bookingId]
    );
    const row = found.rows[0];
    if (!row) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Rendez-vous introuvable'));
    }
    patientName = patientName || row.patient_name;
    patientPhone = patientPhone || compactPhone(row.patient_phone);
    treatmentName = treatmentName || row.treatment_name || '';
  }

  if (!patientName || !patientPhone) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'patientName and patientPhone are required'));
  }

  if (!dueOn) {
    const today = casablancaDateTimeParts();
    const [year, month, day] = today.date.split('-').map(Number);
    const due = new Date(Date.UTC(year, month - 1, day));
    due.setUTCMonth(due.getUTCMonth() + 6);
    dueOn = due.toISOString().slice(0, 10);
  }

  const inserted = await query(
    `INSERT INTO recalls (
       clinic_id, patient_name, patient_phone, due_on, treatment_name, source_booking_id, status, patient_id
     )
     VALUES ($1, $2, $3, $4::date, $5, $6, 'open', $7)
     RETURNING id, patient_name, patient_phone, due_on, treatment_name, source_booking_id, status, patient_id`,
    [
      session.clinic_id,
      patientName,
      patientPhone,
      dueOn,
      treatmentName || null,
      bookingId || null,
      (await ensurePatient(session.clinic_id, { name: patientName, phone: patientPhone }))?.id || null,
    ]
  );
  return res.status(200).json({ ok: true, data: inserted.rows[0] });
}

async function handleReleaseHold(req, res, session) {
  if (session.role !== 'assistant') {
    return res.status(403).json(createApiError('FORBIDDEN', 'Seul le cabinet (assistante) relâche une urgence.'));
  }
  const body = req.body ?? {};
  const holdId = String(body.id ?? body.bookingId ?? body.booking_id ?? '').trim();
  if (!holdId) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'id is required'));
  }
  const treatment = resolveTreatment(body.treatment ?? body.treatment_name);
  if (!treatment) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'Unknown treatment'));
  }
  const patientName = sanitizeString(body.patientName ?? body.patient_name ?? body.name, 100);
  const patientPhone = compactPhone(body.patientPhone ?? body.patient_phone ?? body.phone ?? '');
  if (!patientName || !patientPhone) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'Nom et téléphone requis'));
  }

  const existing = await query(
    `SELECT id, starts_at, duration_min, buffer_min, booking_kind
     FROM bookings
     WHERE clinic_id = $1 AND id::text = $2 AND booking_kind = 'emergency_hold'
     LIMIT 1`,
    [session.clinic_id, holdId]
  );
  const hold = existing.rows[0];
  if (!hold) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Urgence réservée introuvable'));
  }

  if (!body.confirmDuplicate) {
    const matches = await findDuplicateMatches(session.clinic_id, { phone: patientPhone, name: patientName });
    if (matches.length) {
      return res.status(409).json({
        ...createApiError('DUPLICATE_HINT', 'Même téléphone ou même nom dans les 90 derniers jours (pas un dossier patient).'),
        code: 'DUPLICATE_HINT',
        matches,
      });
    }
  }

  const updated = await query(
    `UPDATE bookings
     SET booking_kind = 'visit',
         patient_name = $3,
         patient_phone = $4,
         treatment_name = $5,
         duration_min = $6,
         status = 'Confirme'::appointment_status,
         updated_at = NOW()
     WHERE clinic_id = $1 AND id = $2
     RETURNING
       id, patient_name, patient_phone, treatment_name, status::text AS status,
       starts_at, duration_min, buffer_min, booking_kind, care_started_at, cancel_reason, notes`,
    [session.clinic_id, hold.id, patientName, patientPhone, treatment.name, treatment.duration_min]
  );
  return res.status(200).json({ ok: true, data: updated.rows[0] });
}

async function handleDeleteBlock(req, res, session) {
  if (session.role !== 'doctor') {
    return res.status(403).json(createApiError('FORBIDDEN', 'Seul le docteur retire un blocage.'));
  }
  const body = req.body ?? {};
  const id = String(body.id ?? body.bookingId ?? body.booking_id ?? '').trim();
  if (!id) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'id is required'));
  }
  const deleted = await query(
    `DELETE FROM bookings
     WHERE clinic_id = $1
       AND id::text = $2
       AND booking_kind IN ('block', 'emergency_hold')
     RETURNING id, booking_kind, cal_booking_uid`,
    [session.clinic_id, id]
  );
  if (!deleted.rows[0]) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Blocage introuvable'));
  }
  try {
    if (deleted.rows[0].cal_booking_uid) {
      await cancelCalBusyBooking(deleted.rows[0].cal_booking_uid);
    }
  } catch (err) {
    console.error('[cal-busy-cancel]', err?.message || err);
  }
  return res.status(200).json({ ok: true, data: deleted.rows[0] });
}

async function handleCreate(req, res, session, parsed) {
  const value = parsed.value;
  const bufferMin = await clinicBufferMin(session.clinic_id);

  if (value.kind === 'visit') {
    if (session.role !== 'assistant') {
      return res.status(403).json(createApiError('FORBIDDEN', 'Seul le cabinet (assistante) pose un rendez-vous.'));
    }
    const treatment = resolveTreatment(value.treatment);
    if (!treatment) {
      return res.status(400).json(createApiError('VALIDATION_ERROR', 'Unknown treatment'));
    }

    if (!value.confirmDuplicate) {
      const matches = await findDuplicateMatches(session.clinic_id, {
        phone: value.phone,
        name: value.patientName,
      });
      if (matches.length) {
        return res.status(409).json({
          ...createApiError(
            'DUPLICATE_HINT',
            'Même téléphone ou même nom dans les 90 derniers jours (pas un dossier patient).'
          ),
          code: 'DUPLICATE_HINT',
          matches,
        });
      }
    }

    let startsAt = value.startsAt;
    let status = 'Confirme';
    if (value.walkIn) {
      const today = casablancaDateTimeParts();
      const busy = await loadBusyForDate(session.clinic_id, today.date);
      const gap = findNextGap({
        now: new Date(),
        dateIso: today.date,
        durationMin: treatment.duration_min,
        bufferMin,
        busyRows: busy,
      });
      if (!gap) {
        return res.status(409).json(createApiError('NO_GAP', "Aucun créneau libre aujourd'hui"));
      }
      startsAt = gap.startsAt;
      status = "En salle d'attente";
    }

    const row = await createBookingRow(session.clinic_id, {
      patientName: value.patientName,
      patientPhone: value.phone,
      treatmentName: treatment.name,
      status,
      startsAt,
      durationMin: treatment.duration_min,
      bufferMin,
      kind: 'visit',
      notes: value.notes || null,
      staffId: value.staffId || null,
      chargeMad: value.chargeMad,
    });
    return res.status(201).json({ ok: true, data: row });
  }

  if (session.role !== 'doctor') {
    return res.status(403).json(createApiError('FORBIDDEN', 'Seul le docteur pose un blocage ou une urgence réservée.'));
  }

  const isHold = value.kind === 'emergency_hold';
  const patientName = isHold
    ? 'Urgence réservée'
    : blockDisplayName(value.blockLabel || value.patientName);
  const durationMin = value.durationMin
    || (isHold ? DEFAULT_HOLD_MIN : DEFAULT_BLOCK_MIN);
  const treatmentName = isHold ? 'Urgence' : patientName;

  const row = await createBookingRow(session.clinic_id, {
    patientName,
    patientPhone: '',
    treatmentName,
    status: 'Confirme',
    startsAt: value.startsAt,
    durationMin,
    bufferMin,
    kind: value.kind,
    notes: value.notes || null,
  });
  try {
    const busy = await createCalBusyBooking({
      clinicId: session.clinic_id,
      startsAt: value.startsAt,
      durationMin,
      label: patientName,
      kind: value.kind,
    });
    if (busy.ok && busy.uid) {
      await attachCalUid(row.id, busy.uid);
      row.cal_booking_uid = busy.uid;
    }
  } catch (err) {
    console.error('[cal-busy]', err?.message || err);
  }
  return res.status(201).json({ ok: true, data: row });
}

module.exports = {
  CLINIC_OPEN,
  CLINIC_CLOSE,
  overlapError,
  clinicBufferMin,
  findNextGap,
  loadBusyForDate,
  handleCatalog,
  handleRecallsGet,
  handleRecallCreate,
  handleReleaseHold,
  handleDeleteBlock,
  handleCreate,
  resolveTreatment,
  minutesBetween,
};
