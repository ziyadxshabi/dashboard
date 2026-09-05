# DentaFlow OS — Environment Variables Ledger

> Last audited: 2026-09-05
> Status: Wave 4 — Supabase PostgreSQL + cookie auth
> Secrets belong in Vercel Project Settings (Production / Preview) and local `Temara_Dashboard/.env.local` (gitignored). Never commit real values.

This ledger is the operator-facing list of environment variables for the production dashboard. Runtime architecture is in `SYSTEM_ARCHITECTURE.md`.

---

## Active (required in production)

### PostgreSQL — Supabase

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Supabase **transaction pooler** connection string (**port 6543**). Used by `Temara_Dashboard/api/_lib/db.js` (`pg` Pool). Local Docker/dev may use `postgres://dentaflow:dentaflow@127.0.0.1:5432/dentaflow` (no TLS). Hosted Supabase uses TLS. |

Example shape (placeholder only):

```text
DATABASE_URL=postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Do **not** expose this URL from `/api/health` or any client-facing handler.

### Authentication

| Variable | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **Yes** | HS256 signing key for the httpOnly `dentaflow_session` cookie. **≥ 32 random characters.** Claims: `sub`, `role`, `clinic_id`, `slug`. |

Staff usernames and scrypt hashes live in PostgreSQL `staff_users`, not in env.

### Cal.com

| Variable | Required | Purpose |
| --- | --- | --- |
| `CALCOM_WEBHOOK_SECRET` | Optional | HMAC-SHA256 for `POST /api/webhooks/cal` (`X-Cal-Signature-256`). When unset, the webhook accepts unsigned payloads (dev only). Set in production. |

### Redis / Upstash (optional login rate-limit)

Login throttling in `api/_lib/auth-crypto.js` is optional and **fails open** if Redis is unreachable.

| Variable | Required | Purpose |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | Optional | Upstash REST base URL (rate-limiting). |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Upstash REST bearer token. |

**Runtime aliases (what the code reads today):** `REDIS_CONNECTION_URL` and `REDIS_REST_TOKEN`. Set those to the same values as the Upstash REST URL/token (or duplicate the pair). Missing Redis does **not** block Postgres APIs or health checks.

### Optional clinic / CORS

| Variable | Required | Purpose |
| --- | --- | --- |
| `VERCEL_FRONTEND_URL` | Optional | CORS `Access-Control-Allow-Origin` on selected handlers. |
| `CLINIC_ID` | Optional | Legacy slug fallback; JWT `clinic_id` is authoritative. |

---

## Deprecated / non-blocking

These keys may still exist in Vercel from the Baserow/n8n prototype. They are **not** required for roster, waitlist, dashboard KPIs, public booking, password change, or `/api/health`. Missing values must not take down the OS.

### `BASEROW_*` (deprecated)

| Variable | Status |
| --- | --- |
| `BASEROW_API_URL` | Deprecated — non-blocking. Waitlist/patients are PostgreSQL. |
| `BASEROW_API_TOKEN` | Deprecated — non-blocking. |
| `BASEROW_TABLE_ID` | Deprecated — non-blocking. |
| `BASEROW_WAITLIST_TABLE_ID` | Deprecated — non-blocking. |
| `BASEROW_WAITLIST_BROADCAST_TABLE_ID` | Deprecated — non-blocking. |
| `BASEROW_LEADS_TABLE_ID` | Deprecated — non-blocking. |

### `N8N_WEBHOOK_*` and n8n auth (deprecated)

| Variable | Status |
| --- | --- |
| `N8N_WEBHOOK_URL` | Deprecated — non-blocking. |
| `N8N_WEBHOOK_DASHBOARD` | Deprecated — non-blocking. KPIs come from `/api/dashboard-data` SQL. |
| `N8N_WEBHOOK_ROSTER` | Deprecated — non-blocking. Roster is `/api/roster` SQL. |
| `N8N_WEBHOOK_UPDATE_STATUS` | Deprecated — non-blocking. |
| `N8N_WEBHOOK_DELAY_ALERT` | Deprecated — non-blocking. |
| `N8N_WEBHOOK_FILL_GAP` | Deprecated — non-blocking (optional fan-out only). |
| `N8N_WEBHOOK_BULK_SMS` | Deprecated — non-blocking. |
| `N8N_WEBHOOK_GET_NOTES` | Deprecated — non-blocking. Notes are PostgreSQL. |
| `N8N_WEBHOOK_POST_NOTE` | Deprecated — non-blocking. |
| `N8N_WEBHOOK_LEAD_CAPTURE` | Deprecated — non-blocking. |
| `N8N_WEBHOOK_ASSISTANT_PROXY` | Deprecated — non-blocking. |
| `N8N_WAITLIST_WEBHOOK` | Deprecated — non-blocking. Waitlist is PostgreSQL. |
| `N8N_AUTH_KEY` | Deprecated — non-blocking. |
| `N8N_AGENCY_AUTH_KEY` | Deprecated — non-blocking. |
| `DASHBOARD_AUTH_KEY` | Deprecated — non-blocking. |
| `DASHBOARD_AUTH_KEY_SHA256` | Deprecated — non-blocking. |

### Env-based staff hashes (deprecated)

| Variable | Status |
| --- | --- |
| `DOCTOR_USERNAME` / `DOCTOR_PASSWORD_HASH` | Deprecated — login uses `staff_users`. |
| `ASSISTANT_USERNAME` / `ASSISTANT_PASSWORD_HASH` | Deprecated — login uses `staff_users`. |
| `DOCTOR_PIN` / `ASSISTANT_PIN` | Deprecated prototype. |

### Other leftover names

| Variable | Status |
| --- | --- |
| `CAL_WEBHOOK_SECRET` | Alias leftover; prefer `CALCOM_WEBHOOK_SECRET`. |
| `CALCOM_API_KEY` / `CALCOM_EVENT_TYPE_ID` | n8n-era; event type now lives on `clinics`. |
| Direct `POSTGRES_*` besides `DATABASE_URL` | Unused. |

---

## Environment matrix

| Concern | Development | Production |
| --- | --- | --- |
| `DATABASE_URL` | Local Postgres `:5432` | Supabase pooler `:6543` |
| `JWT_SECRET` | Dev secret (≥ 32 chars) | Unique production secret |
| `CALCOM_WEBHOOK_SECRET` | Optional | Set, HMAC on |
| Upstash Redis | Optional | Optional (login limiter) |
| `BASEROW_*` / `N8N_WEBHOOK_*` | Ignore | Ignore (non-blocking) |
| Frontend | `scripts/dev-server.js` | Vercel |

---

## Security checklist

- [x] `DATABASE_URL` is server-only (Vercel env / `.env.local`)
- [x] `JWT_SECRET` signs httpOnly `dentaflow_session` (not sessionStorage as the credential)
- [x] `/api/health` does not echo URLs or pool stats
- [x] `BASEROW_*` and `N8N_WEBHOOK_*` marked deprecated / non-blocking
- [x] Settings passwords are not stored in `localStorage`

---

*End of ledger — DentaFlow OS*
