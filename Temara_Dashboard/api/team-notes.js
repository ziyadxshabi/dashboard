/**
 * Team notes — clinic-scoped PostgreSQL reads/writes.
 * Auth: dentaflow_session cookie → clinic_id. Roles: doctor | assistant.
 *
 * Physical columns: author_name, content, created_at.
 * API contract aliases: author, message, posted_at, plus pinned/category.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  sanitizeString,
  validateTeamNoteInput,
} = require('./_lib/validation');

const TEAM_NOTES_GET_SQL = `
  SELECT
    id,
    author_name AS author,
    content AS message,
    created_at AS posted_at,
    COALESCE(pinned, false) AS pinned,
    COALESCE(NULLIF(category, ''), 'general') AS category
  FROM team_notes
  WHERE clinic_id = $1
  ORDER BY pinned DESC, posted_at DESC
  LIMIT 50
`;

const TEAM_NOTES_INSERT_SQL = `
  INSERT INTO team_notes (clinic_id, author_name, content, created_at, pinned, category, booking_id, patient_name)
  VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)
  RETURNING
    id,
    author_name AS author,
    content AS message,
    created_at AS posted_at,
    pinned,
    category
`;

const STAFF_DISPLAY_NAME_SQL = `
  SELECT display_name
  FROM staff_users
  WHERE id = $1 AND clinic_id = $2
  LIMIT 1
`;

let schemaReady = false;

async function ensureTeamNotesSchema() {
  if (schemaReady) return;
  await query(`
    ALTER TABLE team_notes
      ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false
  `);
  await query(`
    ALTER TABLE team_notes
      ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'
  `);
  schemaReady = true;
}

function mapTeamNoteRow(row) {
  const message = row.message;
  const postedAt = row.posted_at;
  return {
    id: row.id,
    author: row.author,
    message,
    posted_at: postedAt,
    pinned: Boolean(row.pinned),
    category: row.category || 'general',
    text: message,
    time: postedAt,
  };
}

async function resolveAuthorName(session, bodyAuthor) {
  const fromBody = sanitizeString(bodyAuthor, 120);
  if (fromBody) return fromBody;

  const fromJwt = sanitizeString(session.displayName || session.display_name, 120);
  if (fromJwt) return fromJwt;

  if (session.sub) {
    const result = await query(STAFF_DISPLAY_NAME_SQL, [session.sub, session.clinic_id]);
    const displayName = sanitizeString(result.rows?.[0]?.display_name, 120);
    if (displayName) return displayName;
  }

  return sanitizeString(session.sub, 120) || 'staff';
}

async function handleGet(req, res, session) {
  const result = await query(TEAM_NOTES_GET_SQL, [session.clinic_id]);
  const notes = (result.rows || []).map(mapTeamNoteRow);
  return res.status(200).json({ ok: true, data: notes });
}

async function handlePost(req, res, session) {
  const parsed = validateTeamNoteInput(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { note, patientName, bookingId, author, category, pinned } = parsed.value;
  const authorName = await resolveAuthorName(session, author);

  const result = await query(TEAM_NOTES_INSERT_SQL, [
    session.clinic_id,
    authorName,
    note,
    pinned,
    category,
    bookingId,
    patientName,
  ]);
  const newNote = mapTeamNoteRow(result.rows[0]);

  return res.status(200).json({ ok: true, data: newNote });
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

  const session = requireClinicSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  try {
    await ensureTeamNotesSchema();
    if (req.method === 'GET') {
      return await handleGet(req, res, session);
    }
    return await handlePost(req, res, session);
  } catch (err) {
    return sendDbError(res, err);
  }
};
