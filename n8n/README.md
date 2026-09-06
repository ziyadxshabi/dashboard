# n8n corpus — museum only

These JSON files are **history**, not the running OS. PostgreSQL is the source of truth. Do not import them. Do not restore `N8N_*` / `BASEROW_*` as live env.

Product logic lives in `Temara_Dashboard/api/_lib/` (Twilio, waitlist blast, reminders, leak drip, Cal busy, voice). Canonical behavior: [`CONCIERGE_BEHAVIOR.md`](CONCIERGE_BEHAVIOR.md).

## ported (native Vercel / Postgres / Twilio)

| File | Native handler |
| --- | --- |
| `Production Concierge Engine v2.json` | `POST /api/webhooks/cal` + `_lib/notify.js` + waitlist top-3 |
| `No-Show Waitlist Engine (1).json` | merged into `_lib/waitlist-blast.js` (`waitlist:notified:${e164}` NX 24h) |
| `Appointment Reminders Engine.json` | `GET /api/roster?action=cron-reminders` |
| `Leak Protection Follow-up Engine.json` | `POST /api/roster?action=cron-leak` |
| `Dashboard - Bulk SMS Blast.json` | `POST /api/bulk-sms` |
| `Twilio Voice Menu v4.90 - Linear Pro.json` | `POST /api/webhooks/twilio` (Gather + digit 1 SMS) |
| `Agency Master Error Monitor_v1.2.json` | fail-open Slack in `_lib/notify.js` |
| Superpouvoir Fill / Block / Force (museum wrappers) | `fill-gap.js`, doctor `POST /api/roster` blocks + Cal busy, `bulk-sms?action=force-tomorrow` |

## not ported (intentional)

| File | Why |
| --- | --- |
| `Lead Capture Engine.json` | Optional marketing funnel — would be a 13th Hobby function |
| `Workflow 5 - Bulk Confirm.json` | Per-row JWT status is enough; **do not port PIN** |
| `Dashboard - Bulk Cancel.json` | Same; staff Annulé already waitlist-blasts |
| `_museum/*` | Retired Sheets/Baserow CRUD |
| `_museum/DEPRECATED_waitlist_blueprint.bak` | Never an n8n workflow |
| `skills-lock.json` | Cursor lockfile |

Waitlist WF4’s unauthenticated add is **not** preserved. Staff waitlist stays JWT.

## `_snippets/`

n8n Code-node helpers kept as reference. Runtime equivalents live in `Temara_Dashboard/api/_lib/`.
