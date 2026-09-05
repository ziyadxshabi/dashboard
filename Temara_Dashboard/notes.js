/**
 * Shared team-note / handoff normalizers. Postgres returns plain scalars.
 */
(function () {
  'use strict';

  function asText(value) {
    if (value == null || value === false) return '';
    if (typeof value === 'boolean') return value ? 'true' : '';
    return String(value).trim();
  }

  function asPinned(value) {
    if (value === true || value === 1) return true;
    const text = String(value ?? '').trim().toLowerCase();
    return text === 'true' || text === 'oui' || text === '1';
  }

  function formatNoteTime(raw) {
    const time = asText(raw);
    if (!time) return '';
    if (time.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(time)) {
      const parsed = new Date(time);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Africa/Casablanca',
        });
      }
    }
    return time;
  }

  function unwrapRecord(raw) {
    if (raw?.json && typeof raw.json === 'object' && !Array.isArray(raw.json)) {
      return raw.json;
    }
    return raw;
  }

  function parseNotesResponse(payload) {
    if (payload == null) return [];
    if (Array.isArray(payload)) return payload;
    if (typeof payload !== 'object') return [];

    if (payload.message != null || payload.text != null || payload.Message != null) {
      return [payload];
    }

    const arrayKeys = ['data', 'results', 'items', 'records', 'notes', 'body', 'json'];
    for (const key of arrayKeys) {
      if (Array.isArray(payload[key])) return payload[key];
    }

    if (payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)) {
      return [payload.json];
    }

    return [];
  }

  function normalizeNote(raw) {
    const item = unwrapRecord(raw);
    if (!item || typeof item !== 'object') return null;

    const text = asText(item.message ?? item.text ?? item.Message);
    if (!text) return null;

    const category = asText(item.category) || 'Info';
    const author = asText(item.author);
    const pinned = asPinned(item.pinned);
    const time = formatNoteTime(item.posted_at ?? item.time ?? item.heure);
    const id = item.id ?? item.ID ?? `note-${text.slice(0, 24)}-${time || Date.now()}`;

    return {
      id,
      text,
      type: author ? 'manual' : 'system',
      category,
      pinned,
      author: author || undefined,
      time,
      readBy: Array.isArray(item.readBy) ? item.readBy : [],
    };
  }

  function parseNoteMinutes(time) {
    const [hours, minutes] = String(time || '00:00').split(':').map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }

  function sortNotes(notes) {
    return [...notes].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      return parseNoteMinutes(b.time) - parseNoteMinutes(a.time);
    });
  }

  window.DentaFlowNotes = {
    parseNotesResponse,
    normalizeNote,
    sortNotes,
    parseNoteMinutes,
  };
})();
