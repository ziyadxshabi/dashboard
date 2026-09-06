# n8n corpus — classification

These JSON files are **specs**, not the running OS. PostgreSQL is the source of truth. Do not import museum files. Do not restore `N8N_*` / `BASEROW_*` as live env.

Product logic that still matters is ported in `Temara_Dashboard/api/_lib/` (Twilio, waitlist blast, reminders, leak drip, Cal busy, voice). Canonical behavior: [`CONCIERGE_BEHAVIOR.md`](CONCIERGE_BEHAVIOR.md).

## spec-to-port (keep in this folder until the port is live, then freeze)

| File | Why it stays |
| --- | --- |
| `Production Concierge Engine v2.json` | Cal HMAC, NX, CREATED/CANCELLED/RESCHEDULED SMS+email+Slack, waitlist top-3 |
| `No-Show Waitlist Engine (1).json` | Ranking + `waitlist:notified:${phone}` NX 24h (merged into Concierge blast) |
| `Appointment Reminders Engine.json` | Cron `0 8 * * *` Africa/Casablanca, T-24h ± 30 min |
| `Leak Protection Follow-up Engine.json` | Cron `0 9 * * *`, J+3 / J+7 / J+14 |
| `Dashboard - Bulk SMS Blast.json` | Real Twilio send, E.164, Slack on bad phones |
| `Twilio Voice Menu v4.90 - Linear Pro.json` | Twilio signature, 5/60s rate limit, digit 1 → TwiML + SMS |
| `Agency Master Error Monitor_v1.2.json` | Slack error bus + 5 min Redis dedup (mapped to fail-open Slack) |
| `Lead Capture Engine.json` | Optional later (abandon funnel) |
| `Workflow 5 - Bulk Confirm.json` | Batch Confirmé semantics only — **do not port PIN** |
| `Dashboard - Bulk Cancel.json` | Batch Annulé semantics; app is per-row JWT |

## museum (`_museum/` — do not import)

Retired CRUD that Postgres already owns, inactive placeholders, and Superpouvoir **wrappers** (logic inlined in the app).

## do-not-import

| File | Reason |
| --- | --- |
| `_museum/DEPRECATED_waitlist_blueprint.bak` | Backup, never an n8n workflow |
| `skills-lock.json` | Cursor lockfile, not a workflow |

## `_snippets/`

Shared n8n Code-node helpers kept as reference (`redis_upstash.js`, auth gates). Runtime equivalents live in `Temara_Dashboard/api/_lib/`.
