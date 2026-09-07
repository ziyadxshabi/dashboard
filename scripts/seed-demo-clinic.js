#!/usr/bin/env node
/**
 * Fill the Temara clinic with labelled demo patients, visits, honoraires,
 * waitlist, recalls, plans, and stock so the floor and doctor screens look
 * like a working day. Idempotent: previous [demo-clinic] rows are replaced.
 *
 *   node scripts/seed-demo-clinic.js
 *
 * Does not invent KPIs in the app — amounts are staff-entered charge_mad
 * on real booking rows. Patients récupérés stays 0 (no recovered-slot table).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'Temara_Dashboard');
const MARKER = '[demo-clinic]';

function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(DASHBOARD, '.env.local'));
loadEnvFile(path.join(DASHBOARD, '.env'));

const { query, getPool } = require(path.join(DASHBOARD, 'api/_lib/db.js'));
const { ensurePatient } = require(path.join(DASHBOARD, 'api/_lib/patients.js'));
const { toE164MA } = require(path.join(DASHBOARD, 'api/_lib/phone-e164.js'));
const { findNextGap, loadBusyForDate } = require(path.join(DASHBOARD, 'api/_lib/roster-ops.js'));

const PEOPLE = [
  {
    key: 'fatima',
    name: 'Fatima El Amrani',
    phone: '0699100001',
    insurance: 'cnss',
    allergies: 'Pénicilline',
    chronic: 'Hypertension',
    anesthetic: 'Articaine',
    xrayDaysAgo: 40,
  },
  {
    key: 'youssef',
    name: 'Youssef Benjelloun',
    phone: '0699100002',
    insurance: 'cnops',
    allergies: null,
    chronic: 'Diabète type 2',
    anesthetic: 'Lidocaïne',
    xrayDaysAgo: 12,
  },
  {
    key: 'nadia',
    name: 'Nadia Chraibi',
    phone: '0699100003',
    insurance: 'prive',
    allergies: 'Latex',
    chronic: null,
    anesthetic: 'Articaine',
    xrayDaysAgo: 90,
  },
  {
    key: 'omar',
    name: 'Omar Tazi',
    phone: '0699100004',
    insurance: 'cnss',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: null,
  },
  {
    key: 'salma',
    name: 'Salma Idrissi',
    phone: '0699100005',
    insurance: 'cnops',
    allergies: 'Aspirine',
    chronic: 'Asthme',
    anesthetic: 'Scandonest',
    xrayDaysAgo: 20,
  },
  {
    key: 'karim',
    name: 'Karim Berrada',
    phone: '0699100006',
    insurance: 'none',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: 7,
  },
  {
    key: 'amina',
    name: 'Amina Fassi',
    phone: '0699100007',
    insurance: 'cnss',
    allergies: null,
    chronic: 'Grossesse T2',
    anesthetic: 'Lidocaïne sans adrénaline',
    xrayDaysAgo: 200,
  },
  {
    key: 'hassan',
    name: 'Hassan Ouazzani',
    phone: '0699100008',
    insurance: 'prive',
    allergies: null,
    chronic: null,
    anesthetic: 'Articaine',
    xrayDaysAgo: 5,
  },
  {
    key: 'leila',
    name: 'Leila Bennani',
    phone: '0699100009',
    insurance: 'cnops',
    allergies: 'Iode',
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: 60,
  },
  {
    key: 'mehdi',
    name: 'Mehdi Kettani',
    phone: '0699100010',
    insurance: 'cnss',
    allergies: null,
    chronic: null,
    anesthetic: 'Articaine',
    xrayDaysAgo: 3,
  },
  {
    key: 'sara',
    name: 'Sara Lahlou',
    phone: '0699100011',
    insurance: 'prive',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: 15,
  },
  {
    key: 'rachid',
    name: 'Rachid Mernissi',
    phone: '0699100012',
    insurance: 'none',
    allergies: 'Pénicilline',
    chronic: 'Tabagisme',
    anesthetic: 'Articaine',
    xrayDaysAgo: 8,
  },
  {
    key: 'imane',
    name: 'Imane Kadiri',
    phone: '0699100013',
    insurance: 'cnss',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: 25,
  },
  {
    key: 'anas',
    name: 'Anas Berrada',
    phone: '0699100014',
    insurance: 'cnops',
    allergies: null,
    chronic: null,
    anesthetic: 'Lidocaïne',
    xrayDaysAgo: 18,
  },
  {
    key: 'nour',
    name: 'Nour El Fassi',
    phone: '0699100015',
    insurance: 'prive',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: null,
  },
  {
    key: 'siham',
    name: 'Siham Alaoui',
    phone: '0699100016',
    insurance: 'cnss',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: 4,
  },
  {
    key: 'tarik',
    name: 'Tarik Benkirane',
    phone: '0699100017',
    insurance: 'none',
    allergies: null,
    chronic: null,
    anesthetic: null,
    xrayDaysAgo: 11,
  },
  {
    key: 'ghita',
    name: 'Ghita Senhaji',
    phone: '0699100018',
    insurance: 'cnops',
    allergies: 'Latex',
    chronic: null,
    anesthetic: 'Scandonest',
    xrayDaysAgo: 33,
  },
];

function note(text) {
  return text ? `${text} ${MARKER}` : MARKER;
}

async function casablancaDate(dayOffset) {
  const result = await query(
    `SELECT ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + $1::int)::text AS d`,
    [dayOffset]
  );
  return result.rows[0].d;
}

async function insertVisit(clinicId, people, spec) {
  const person = people[spec.who];
  if (!person) throw new Error(`Unknown person ${spec.who}`);
  const kind = spec.kind || 'visit';
  const status = spec.status || 'Confirme';
  const duration = spec.duration || 20;
  const buffer = spec.buffer == null ? 10 : spec.buffer;
  const dateIso = await casablancaDate(spec.day || 0);
  const busy = await loadBusyForDate(clinicId, dateIso);
  const gap = findNextGap({
    now: new Date(0),
    dateIso,
    durationMin: duration,
    bufferMin: buffer,
    busyRows: busy,
    fromTime: spec.time || '08:00',
  });
  if (!gap?.startsAt) {
    if (spec.optional) {
      console.warn(`skip ${person.name} on ${dateIso} (no chair from ${spec.time})`);
      return null;
    }
    throw new Error(`No free chair for ${person.name} on ${dateIso} from ${spec.time}`);
  }
  const startsAt = gap.startsAt;
  const result = await query(
    `INSERT INTO bookings (
       clinic_id, patient_name, patient_phone, treatment_name, status,
       starts_at, duration_min, buffer_min, booking_kind, notes,
       patient_id, staff_id, charge_mad, cancel_reason, care_started_at,
       patient_confirmed_at, confirmation_state, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5::appointment_status,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15,
       $16, $17, NOW()
     )
     RETURNING id`,
    [
      clinicId,
      kind === 'block' ? spec.blockName || 'Indisponible' : person.name,
      kind === 'block' ? '' : person.phone,
      spec.treatment || null,
      status,
      startsAt,
      duration,
      buffer,
      kind,
      note(spec.notes || ''),
      kind === 'block' ? null : person.id,
      spec.staffId || null,
      spec.charge == null ? null : spec.charge,
      spec.cancelReason || null,
      spec.careStarted ? startsAt : null,
      spec.confirmed ? startsAt : null,
      spec.confirmation || (spec.confirmed ? 'confirmed' : null),
    ]
  );
  return result.rows[0].id;
}

async function wipeDemo(clinicId) {
  await query(
    `DELETE FROM stock_uses
     WHERE clinic_id = $1
       AND (
         booking_id IN (SELECT id FROM bookings WHERE clinic_id = $1 AND notes LIKE $2)
         OR item_id IN (SELECT id FROM stock_items WHERE clinic_id = $1 AND name LIKE '%(démo)')
       )`,
    [clinicId, `%${MARKER}%`]
  );
  await query(
    `DELETE FROM plan_steps
     WHERE plan_id IN (
       SELECT id FROM treatment_plans
       WHERE clinic_id = $1 AND title LIKE $2
     )`,
    [clinicId, `%${MARKER}%`]
  );
  await query(`DELETE FROM treatment_plans WHERE clinic_id = $1 AND title LIKE $2`, [
    clinicId,
    `%${MARKER}%`,
  ]);
  await query(`DELETE FROM team_notes WHERE clinic_id = $1 AND content LIKE $2`, [
    clinicId,
    `%${MARKER}%`,
  ]);
  await query(`DELETE FROM recalls WHERE clinic_id = $1 AND patient_phone LIKE '06991%'`, [clinicId]);
  await query(`DELETE FROM waitlist WHERE clinic_id = $1 AND patient_phone LIKE '06991%'`, [clinicId]);
  await query(
    `DELETE FROM bookings
     WHERE clinic_id = $1
       AND (notes LIKE $2 OR patient_phone LIKE '06991%')`,
    [clinicId, `%${MARKER}%`]
  );
  await query(`DELETE FROM stock_items WHERE clinic_id = $1 AND name LIKE '%(démo)'`, [clinicId]);
  await query(`DELETE FROM patients WHERE clinic_id = $1 AND phone_e164 LIKE '+2126991%'`, [clinicId]);
}

async function upsertPeople(clinicId) {
  const byKey = {};
  for (const person of PEOPLE) {
    const row = await ensurePatient(clinicId, {
      name: person.name,
      phone: person.phone,
      smsConsent: true,
    });
    if (!row?.id) {
      throw new Error(`Could not create patient ${person.name}`);
    }
    const xray = person.xrayDaysAgo == null
      ? null
      : await query(
        `SELECT ((NOW() AT TIME ZONE 'Africa/Casablanca')::date - $1::int) AS d`,
        [person.xrayDaysAgo]
      );
    await query(
      `UPDATE patients
       SET display_name = $2,
           insurance_type = $3,
           allergies = $4,
           chronic_conditions = $5,
           preferred_anesthetic = $6,
           last_xray_on = $7,
           sms_consent = true,
           updated_at = NOW()
       WHERE id = $1`,
      [
        row.id,
        person.name,
        person.insurance,
        person.allergies,
        person.chronic,
        person.anesthetic,
        xray?.rows[0]?.d || null,
      ]
    );
    byKey[person.key] = {
      ...person,
      id: row.id,
      e164: toE164MA(person.phone),
    };
  }
  return byKey;
}

async function run() {
  const clinic = await query(`SELECT id FROM clinics WHERE slug = 'temara' LIMIT 1`);
  const clinicId = clinic.rows[0]?.id;
  if (!clinicId) {
    throw new Error('Clinic slug temara is missing');
  }
  const doctor = await query(
    `SELECT id FROM staff_users WHERE clinic_id = $1 AND role = 'doctor' ORDER BY username LIMIT 1`,
    [clinicId]
  );
  const staffId = doctor.rows[0]?.id || null;

  await wipeDemo(clinicId);
  const people = await upsertPeople(clinicId);

  const todayVisits = [
    { who: 'fatima', time: '08:00', duration: 20, status: 'Termine', treatment: 'Consultation', charge: 150, confirmed: true, notes: 'Contrôle post-détartrage' },
    { who: 'youssef', time: '08:30', duration: 30, status: 'Termine', treatment: 'Détartrage', charge: 250, confirmed: true, notes: 'Détartrage complet' },
    { who: 'nadia', time: '09:10', duration: 40, status: 'Termine', treatment: 'Soin', charge: 400, confirmed: true, staffId, notes: 'Composite 16' },
    { who: 'omar', time: '10:00', duration: 20, status: 'No-show', treatment: 'Consultation', charge: null, notes: 'Absent sans préavis' },
    { who: 'hassan', time: '10:30', duration: 45, status: 'Termine', treatment: 'Couronne', charge: 2500, confirmed: true, staffId, notes: 'Pose couronne 26' },
    { who: 'salma', time: '11:25', duration: 20, status: "En salle d'attente", treatment: 'Consultation', charge: 150, confirmed: true, notes: 'Arrivée, dossier ouvert' },
    { who: 'mehdi', time: '11:55', duration: 40, status: 'En soin', treatment: 'Soin', charge: 400, careStarted: true, confirmed: true, staffId, notes: 'Carie 36 en cours' },
    { who: 'karim', time: '12:45', duration: 60, buffer: 0, status: 'Confirme', kind: 'block', blockName: 'Déjeuner', treatment: null, notes: 'Pause déjeuner' },
    { who: 'leila', time: '14:00', duration: 30, status: 'Termine', treatment: 'Extraction', charge: 350, confirmed: true, notes: 'Avulsion 48' },
    { who: 'rachid', time: '14:40', duration: 20, status: 'Annule', treatment: 'Consultation', cancelReason: 'oublie', notes: 'Annulé le matin' },
    { who: 'sara', time: '15:10', duration: 20, status: 'Confirme', treatment: 'Consultation', charge: 150, confirmation: 'unconfirmed', notes: 'Pas de réponse au rappel' },
    { who: 'imane', time: '15:40', duration: 30, status: 'Confirme', treatment: 'Détartrage', charge: 250, confirmed: true, notes: 'Rappel confirmé par SMS' },
    { who: 'anas', time: '16:20', duration: 60, status: 'Confirme', treatment: 'Dévitalisation', charge: 800, staffId, confirmed: true, notes: 'Endo 21 séance 1' },
    { who: 'nour', time: '17:30', duration: 20, status: 'En attente', treatment: 'Consultation', notes: 'Placé depuis la liste d\'attente' },
    { who: 'siham', time: '18:00', duration: 20, status: 'Confirme', treatment: 'Urgence', charge: 200, confirmation: 'unconfirmed', notes: 'Douleur pulpaire' },
  ];

  const bookingIds = {};
  for (const spec of todayVisits) {
    bookingIds[`${spec.who}-${spec.time}`] = await insertVisit(clinicId, people, spec);
  }

  const weekTreatments = [
    { who: 'fatima', treatment: 'Consultation', charge: 150, time: '08:00' },
    { who: 'youssef', treatment: 'Détartrage', charge: 250, time: '08:00' },
    { who: 'nadia', treatment: 'Soin', charge: 400, time: '08:00' },
    { who: 'omar', treatment: 'Urgence', charge: 200, time: '08:00' },
  ];
  for (let day = 1; day <= 6; day += 1) {
    for (const spec of weekTreatments) {
      await insertVisit(clinicId, people, {
        ...spec,
        day: -day,
        duration: spec.treatment === 'Détartrage' ? 30 : spec.treatment === 'Soin' ? 40 : 20,
        status: 'Termine',
        confirmed: true,
        optional: true,
        notes: `Visite J-${day}`,
      });
    }
  }

  const returning = [
    { who: 'fatima', time: '09:00' },
    { who: 'youssef', time: '09:40' },
    { who: 'nadia', time: '10:20' },
    { who: 'hassan', time: '11:00' },
    { who: 'leila', time: '11:50' },
  ];
  for (const spec of returning) {
    await insertVisit(clinicId, people, {
      who: spec.who,
      day: -28,
      time: spec.time,
      duration: 20,
      status: 'Termine',
      treatment: 'Consultation',
      charge: 150,
      confirmed: true,
      optional: true,
      notes: 'Visite du mois dernier',
    });
  }

  const tomorrow = [
    { who: 'tarik', time: '09:00', treatment: 'Consultation', duration: 20, charge: 150 },
    { who: 'ghita', time: '09:40', treatment: 'Détartrage', duration: 30, charge: 250 },
    { who: 'fatima', time: '10:30', treatment: 'Contrôle', duration: 20, charge: 150 },
    { who: 'hassan', time: '11:10', treatment: 'Couronne', duration: 45, charge: 800, staffId },
  ];
  for (const spec of tomorrow) {
    await insertVisit(clinicId, people, {
      ...spec,
      day: 1,
      status: 'Confirme',
      confirmed: spec.who === 'fatima',
      confirmation: spec.who === 'fatima' ? 'confirmed' : 'unconfirmed',
      optional: true,
      notes: 'RDV demain',
    });
  }

  const waitlist = [
    { who: 'tarik', priority: 'Urgent', notes: 'Douleur 36, créneau dès aujourd\'hui' },
    { who: 'ghita', priority: 'Haute', notes: 'Détartrage reporté deux fois' },
    { who: 'siham', priority: 'Moyenne', notes: 'Contrôle grossesse' },
    { who: 'nour', priority: 'Urgent', notes: 'Urgence pulpaire si trou' },
    { who: 'anas', priority: 'Faible', notes: 'Blanchiment esthétique' },
  ];
  for (const row of waitlist) {
    const person = people[row.who];
    await query(
      `INSERT INTO waitlist (
         clinic_id, patient_name, patient_phone, priority, notes, status, sms_consent, patient_id
       )
       VALUES ($1, $2, $3, $4::waitlist_priority, $5, 'active', true, $6)`,
      [clinicId, person.name, person.phone, row.priority, note(row.notes), person.id]
    );
  }

  const recalls = [
    { who: 'fatima', days: 0, treatment: 'Détartrage', status: 'open' },
    { who: 'youssef', days: -3, treatment: 'Contrôle', status: 'open' },
    { who: 'leila', days: 14, treatment: 'Consultation', status: 'open' },
    { who: 'hassan', days: 40, treatment: 'Couronne', status: 'open' },
  ];
  for (const row of recalls) {
    const person = people[row.who];
    await query(
      `INSERT INTO recalls (
         clinic_id, patient_name, patient_phone, due_on, treatment_name, status, patient_id
       )
       VALUES (
         $1, $2, $3,
         (NOW() AT TIME ZONE 'Africa/Casablanca')::date + $4::int,
         $5, $6, $7
       )`,
      [clinicId, person.name, person.phone, row.days, row.treatment, row.status, person.id]
    );
  }

  async function insertPlan(who, title, status, steps) {
    const person = people[who];
    const plan = await query(
      `INSERT INTO treatment_plans (clinic_id, patient_id, title, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [clinicId, person.id, `${title} ${MARKER}`, status]
    );
    const planId = plan.rows[0].id;
    for (let i = 0; i < steps.length; i += 1) {
      await query(
        `INSERT INTO plan_steps (plan_id, position, label, done_at)
         VALUES ($1, $2, $3, $4)`,
        [planId, i + 1, steps[i].label, steps[i].done ? new Date() : null]
      );
    }
  }

  await insertPlan('hassan', 'Couronne 26', 'open', [
    { label: 'Empreinte', done: true },
    { label: 'Essayage', done: true },
    { label: 'Pose définitive', done: false },
  ]);
  await insertPlan('anas', 'Endo 21', 'open', [
    { label: 'Ouverture et mise en forme', done: false },
    { label: 'Obturation canalaire', done: false },
  ]);
  await insertPlan('nadia', 'Composite 16', 'done', [
    { label: 'Éviction carieuse', done: true },
    { label: 'Composite', done: true },
  ]);

  const notes = [
    { who: 'mehdi', author: 'Assistante Témara', content: 'Patient au fauteuil, anesthésie posée.', pinned: true, category: 'handoff' },
    { who: 'salma', author: 'Assistante Témara', content: 'Asthme — avoir la ventoline en salle.', pinned: true, category: 'clinical' },
    { who: 'omar', author: 'Dr. Témara', content: 'No-show. Rappeler demain pour replacer.', pinned: false, category: 'ops' },
    { who: 'hassan', author: 'Dr. Témara', content: 'Couronne 26: teinte A2, patient satisfait de l\'essayage.', pinned: false, category: 'clinical' },
  ];
  for (const row of notes) {
    const person = people[row.who];
    const bookingId = Object.entries(bookingIds).find(([key]) => key.startsWith(`${row.who}-`))?.[1] || null;
    await query(
      `INSERT INTO team_notes (
         clinic_id, author_name, content, pinned, category, booking_id, patient_name, patient_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clinicId, row.author, note(row.content), row.pinned, row.category, bookingId, person.name, person.id]
    );
  }

  const stock = [
    { name: 'Gants nitrile (démo)', qty: 80, reorder: 40 },
    { name: 'Anesthésie articaine (démo)', qty: 12, reorder: 8 },
    { name: 'Composite A2 (démo)', qty: 4, reorder: 6 },
    { name: 'Fil de suture (démo)', qty: 18, reorder: 10 },
  ];
  const stockIds = {};
  for (const item of stock) {
    const inserted = await query(
      `INSERT INTO stock_items (clinic_id, name, qty, reorder_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [clinicId, item.name, item.qty, item.reorder]
    );
    stockIds[item.name] = inserted.rows[0].id;
  }
  const soinId = bookingIds['nadia-09:10'];
  const extractId = bookingIds['leila-14:00'];
  if (soinId) {
    await query(
      `INSERT INTO stock_uses (clinic_id, item_id, booking_id, qty) VALUES ($1, $2, $3, 1)`,
      [clinicId, stockIds['Composite A2 (démo)'], soinId]
    );
    await query(`UPDATE stock_items SET qty = qty - 1, updated_at = NOW() WHERE id = $1`, [
      stockIds['Composite A2 (démo)'],
    ]);
  }
  if (extractId) {
    await query(
      `INSERT INTO stock_uses (clinic_id, item_id, booking_id, qty) VALUES ($1, $2, $3, 1)`,
      [clinicId, stockIds['Fil de suture (démo)'], extractId]
    );
    await query(`UPDATE stock_items SET qty = qty - 1, updated_at = NOW() WHERE id = $1`, [
      stockIds['Fil de suture (démo)'],
    ]);
  }

  const counts = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM patients WHERE clinic_id = $1 AND phone_e164 LIKE '+2126991%') AS patients,
       (SELECT COUNT(*)::int FROM bookings WHERE clinic_id = $1 AND notes LIKE $2) AS bookings,
       (SELECT COUNT(*)::int FROM waitlist WHERE clinic_id = $1 AND patient_phone LIKE '06991%') AS waitlist,
       (SELECT COUNT(*)::int FROM recalls WHERE clinic_id = $1 AND patient_phone LIKE '06991%') AS recalls,
       (SELECT COUNT(*)::int FROM treatment_plans WHERE clinic_id = $1 AND title LIKE $2) AS plans,
       (SELECT COALESCE(SUM(charge_mad), 0)::numeric FROM bookings
         WHERE clinic_id = $1 AND notes LIKE $2
           AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
             = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
           AND status::text NOT IN ('Annule')
           AND charge_mad IS NOT NULL) AS charge_today`,
    [clinicId, `%${MARKER}%`]
  );

  console.log('Demo clinic seed ready (Temara).');
  console.log(JSON.stringify(counts.rows[0], null, 2));
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch {
      // ignore
    }
  });
