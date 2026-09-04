/**
 * Team notes — clinic-scoped PostgreSQL reads/writes.
 * Auth: dentaflow_session cookie → clinic_id, sub, optional displayName.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateTeamNoteInput,
} = require('./_lib/validation');

const TEAM_NOTES_GET_SQL = `
  SELECT id, booking_id, patient_name, author_name, content, created_at
  FROM team_notes
  WHERE clinic_id = $1
  ORDER BY created_at DESC
  LIMIT 50
`;

const TEAM_NOTES_INSERT_SQL = `
  INSERT INTO team_notes (clinic_id, booking_id, patient_name, author_name, content)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id, created_at
`;

const STAFF_DISPLAY_NAME_SQL = `
  SELECT display_name
  FROM staff_users
  WHERE id = $1 AND clinic_id = $2
  LIMIT 1
`;

function mapTeamNoteRow(row) {
  return {
    id: row.id,
    booking_id: row.booking_id,
    patient_name: row.patient_name,
    author: row.author_name,
    text: row.content,
    created_at: row.created_at,
  };
}

async function resolveAuthorName(session, bodyAuthor) {
  const fromBody = String(bodyAuthor || '').trim();
  if (fromBody) return fromBody;

  const fromJwt = String(session.displayName || session.display_name || '').trim();
  if (fromJwt) return fromJwt;

  if (session.sub) {
    const result = await query(STAFF_DISPLAY_NAME_SQL, [session.sub, session.clinic_id]);
    const displayName = String(result.rows?.[0]?.display_name || '').trim();
    if (displayName) return displayName;
  }

  return String(session.sub || 'staff');
}

async function handleGet(req, res, session) {
  const result = await query(TEAM_NOTES_GET_SQL, [session.clinic_id]);
  const rows = (result.rows || []).map(mapTeamNoteRow);
  return res.status(200).json({ ok: true, data: rows });
}

async function handlePost(req, res, session) {
  const parsed = validateTeamNoteInput(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { note, patientName, bookingId, author } = parsed.value;
  const authorName = await resolveAuthorName(session, author);

  const result = await query(TEAM_NOTES_INSERT_SQL, [
    session.clinic_id,
    bookingId,
    patientName,
    authorName,
    note,
  ]);
  const insertedRow = result.rows[0];

  return res.status(200).json({ ok: true, data: insertedRow });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, POST, OPTIONS');

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res, session);
    }
    return await handlePost(req, res, session);
  } catch (err) {
    return sendDbError(res, err);
  }
};
