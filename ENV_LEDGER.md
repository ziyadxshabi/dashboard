# DentaFlow OS — Environment Variables Ledger

> Last audited: 2026-09-05
> Status: Wave 4 — active production variables only
> Secrets belong in Vercel Project Settings and gitignored `Temara_Dashboard/.env.local`. Never commit real values.

This ledger lists **exactly** the variables the running OS reads. Architecture: `SYSTEM_ARCHITECTURE.md`.

---

## Active variables

### `DATABASE_URL` — required

Supabase **transaction pooler** connection string on **port 6543**.

- Consumer: `Temara_Dashboard/api/_lib/db.js` (`pg` Pool).
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
| `CALCOM_API_KEY` / `CALCOM_EVENT_TYPE_ID` | Event type lives on `clinics`. |
| `POSTGRES_HOST` / `POSTGRES_PASSWORD` (besides `DATABASE_URL`) | Unused. |

---

## Environment matrix

| Variable | Development | Production |
| --- | --- | --- |
| `DATABASE_URL` | Local `:5432` or pooler `:6543` | Supabase pooler `:6543` |
| `JWT_SECRET` | Generated local secret | Unique production secret |
| `CLINIC_ID` | `temara` | Default slug only |
| `CALCOM_WEBHOOK_SECRET` | Optional | Set, HMAC on |
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
