# DentaFlow OS — Environment Variables Ledger

> Last audited: 2026-09-06
> Status: Wave 4 — active production variables only
> Secrets belong in Vercel Project Settings and gitignored `Temara_Dashboard/.env.local`. Never commit real values.

This ledger lists **exactly** the variables the running OS reads. Architecture: `SYSTEM_ARCHITECTURE.md`.

---

## Active variables

### `DATABASE_URL` — required

Supabase **transaction pooler** connection string on **port 6543**.

- Consumer: `Temara_Dashboard/api/_lib/db.js` (`pg` Pool).
- Production **and Preview** must both have this set. A Vercel preview without `DATABASE_URL` returns 503 on login.
- Production: TLS (`ssl: { rejectUnauthorized: false }` for the pooler). Direct `db.<ref>.supabase.co:5432` is IPv6-only and is not used here.
- Local Docker/dev may use `postgres://dentaflow:dentaflow@127.0.0.1:5432/dentaflow` (no TLS).

```text
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres
```

Never return this URL from `/api/health` or any client-facing handler.

### `JWT_SECRET` — required

HS256 signing key for the httpOnly `dentaflow_session` cookie.

- Consumer: `api/_lib/auth-crypto.js`, `api/auth.js`, `requireClinicSession`.
- **≥ 32 random bytes** (hex or base64). Rotate independently of the database password.
- Claims: `sub`, `role`, `clinic_id`, `slug`.
- Production **and Preview** must both have this set. Missing `JWT_SECRET` makes `POST /api/auth` return 503; anonymous `/api/auth/me` still returns 401.

### `CLINIC_ID` — default tenant slug

Default clinic slug when a JWT has no `clinic_id` (should not happen after login). Example: `temara`.

- Consumer: `requireClinicSession` fallback and public defaults.
- Authoritative tenant id at runtime is **`clinics.id` (UUID)** on the JWT, not this slug.
- Public booking still defaults missing `/book/:slug` to `temara`.

### `CALCOM_WEBHOOK_SECRET` — production required

HMAC-SHA256 secret for `POST /api/webhooks/cal`.

- Header: `X-Cal-Signature-256`.
- When **set**: unsigned or mismatched signatures are rejected.
- When **unset** (local only): unsigned payloads are accepted so handler tests can run.

### `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — optional

Upstash Redis REST credentials for **login rate-limiting only** (not sessions, not patient data).

- Consumer: `api/_lib/auth-crypto.js`.
- If either is missing or Redis errors, rate limiting **fails open**. Postgres APIs keep working.
- Legacy aliases still accepted: `REDIS_CONNECTION_URL`, `REDIS_REST_TOKEN`.

### `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` — optional (SMS off without them)

Twilio Programmable SMS. Handlers never report `dispatchedCount > 0` without a SID.

- Consumers: `api/_lib/twilio.js`, `api/bulk-sms.js`, Concierge notify, crons, `api/webhooks/twilio.js`.
- `TWILIO_FROM` may be overridden per clinic by `clinics.twilio_from`.
- Alias accepted: `TWILIO_FROM_NUMBER` only. `N8N_TWILIO_AUTH_TOKEN` is not read.

### `TWILIO_WEBHOOK_URL` — production required for inbound SMS/voice

Canonical public URL of `POST /api/webhooks/twilio` (Twilio signature validation). Example: `https://<host>/api/webhooks/twilio`.

### `RESEND_API_KEY` / `RESEND_FROM` — optional (email fail-open)

Concierge confirmation / cancel / reschedule and reminder emails. Missing keys skip email.

### `SLACK_WEBHOOK_URL` — optional (fail-open)

Incoming webhook for RDV + SMS-failure alerts (replaces n8n Slack credential).

### `CRON_SECRET` — production required for Vercel cron

Bearer or `x-cron-secret` for `GET|POST /api/roster?action=cron-reminders` and `cron-leak`. Staff JWT is also accepted (ops override).

### `CALCOM_API_KEY` / `CLINIC_URGENCY_EMAIL` — optional Cal busy sync

When a doctor creates a Postgres block, DentaFlow may `POST https://api.cal.com/v1/bookings` so `/book/temara` stops offering that slot. Event type is `clinics.cal_event_type_id`. Missing keys skip Cal; Postgres block still succeeds.

---

## Local development (`.env.local`)

`scripts/setup-dev-env.sh` writes `Temara_Dashboard/.env.local` when missing:

```text
DATABASE_URL=postgres://dentaflow:dentaflow@127.0.0.1:5432/dentaflow
JWT_SECRET=<generated>
CLINIC_ID=temara
```

Seeded UI logins (scrypt hashes live in `staff_users`, not in env):

- Médecin: `docteur` / `dentaflow` (alias `doctor`)
- Assistant(e): `assistante` / `dentaflow` (alias `assistant`)

---

## Fully deprecated (do not set, do not restore)

These names may still exist in an old Vercel project. They are **not** read by live roster, waitlist, notes, fill-gap, bulk-sms audit, KPIs, public booking, auth, or health. Missing values must not take down the OS. Remove them when convenient.

### Baserow — fully deprecated

| Variable | Status |
| --- | --- |
| `BASEROW_API_URL` | Fully deprecated. Patients/waitlist are PostgreSQL. |
| `BASEROW_API_TOKEN` | Fully deprecated. |
| `BASEROW_TABLE_ID` | Fully deprecated. |
| `BASEROW_WAITLIST_TABLE_ID` | Fully deprecated. |
| `BASEROW_WAITLIST_BROADCAST_TABLE_ID` | Fully deprecated. |
| `BASEROW_LEADS_TABLE_ID` | Fully deprecated. |

### ngrok / n8n tunnels — fully deprecated

| Variable | Status |
| --- | --- |
| `N8N_WEBHOOK_URL` and all `N8N_WEBHOOK_*` | Fully deprecated. No live handler proxies n8n. |
| `N8N_WAITLIST_WEBHOOK` | Fully deprecated. |
| `N8N_AUTH_KEY` / `N8N_AGENCY_AUTH_KEY` | Fully deprecated. |
| `DASHBOARD_AUTH_KEY` / `DASHBOARD_AUTH_KEY_SHA256` | Fully deprecated. |
| Any ngrok `*.ngrok-free.app` / `*.ngrok.io` URL | Fully deprecated. |

### Other leftovers

| Variable | Status |
| --- | --- |
| `DOCTOR_USERNAME` / `DOCTOR_PASSWORD_HASH` | Deprecated. Login uses `staff_users`. |
| `ASSISTANT_USERNAME` / `ASSISTANT_PASSWORD_HASH` | Deprecated. |
| `DOCTOR_PIN` / `ASSISTANT_PIN` | Deprecated prototype. |
| `CAL_WEBHOOK_SECRET` | Use `CALCOM_WEBHOOK_SECRET`. |
| `CALCOM_EVENT_TYPE_ID` | Event type lives on `clinics.cal_event_type_id`. `CALCOM_API_KEY` is optional again for busy sync. |
| `POSTGRES_HOST` / `POSTGRES_PASSWORD` (besides `DATABASE_URL`) | Unused. |

---

## Environment matrix

| Variable | Development | Production |
| --- | --- | --- |
| `DATABASE_URL` | Local `:5432` or pooler `:6543` | Supabase pooler `:6543` |
| `JWT_SECRET` | Generated local secret | Unique production secret |
| `CLINIC_ID` | `temara` | Default slug only |
| `CALCOM_WEBHOOK_SECRET` | Optional | Set, HMAC on |
| `TWILIO_ACCOUNT_SID` / `AUTH_TOKEN` / `FROM` | Optional | Set to send SMS |
| `TWILIO_WEBHOOK_URL` | Optional | Public Twilio callback |
| `RESEND_API_KEY` / `SLACK_WEBHOOK_URL` | Optional | Fail-open notify |
| `CRON_SECRET` | Optional | Set for Vercel cron |
| `CALCOM_API_KEY` | Optional | Doctor block → Cal busy |
| `UPSTASH_REDIS_REST_URL` / `TOKEN` | Optional | Optional login limiter |
| Baserow / ngrok / n8n | Ignore | Ignore / delete |

---

## Security checklist

- [ ] `DATABASE_URL` is server-only (Vercel env / `.env.local`)
- [ ] `JWT_SECRET` is unique per environment and ≥ 32 characters
- [ ] `/api/health` does not echo URLs or pool stats
- [ ] `CALCOM_WEBHOOK_SECRET` is set in production
- [ ] Baserow, ngrok, and `N8N_*` keys are removed from Vercel when possible
- [ ] `.env.local` is gitignored

---

*End of ledger — DentaFlow OS*
