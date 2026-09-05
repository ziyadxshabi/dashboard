# DentaFlow OS — System Architecture

> **Classification:** Internal developer reference
> **Scope:** Multi-clinic booking, operations, messaging, and staff auth
> **Last aligned to codebase:** production dashboard (`Temara_Dashboard`), Supabase PostgreSQL, Vercel serverless APIs

---

## 1. System Overview & Core Philosophy

### 1.1 Single Source of Truth (SSOT)

DentaFlow OS is a **multi-tenant clinic operating system**. One PostgreSQL database (Supabase) holds every durable operational fact. Tenant isolation is enforced by `clinic_id` foreign keys on every operational table — never by separate databases per clinic.

| Domain | Authoritative store | Consumers |
| --- | --- | --- |
| Clinic identity, branding, Cal.com event type | **PostgreSQL `clinics`** | Public booking portal, staff JWT (`slug`, `clinic_id`) |
| Staff credentials | **PostgreSQL `staff_users`** | `POST /api/auth`, password rotation |
| Appointments / day roster | **PostgreSQL `bookings`** (synced from Cal.com) | `/api/roster`, `/api/dashboard-data`, `/api/update-status` |
| Waitlist | **PostgreSQL `waitlist`** | `/api/waitlist`, `/api/fill-gap`, `/api/lead-capture` |
| Team notes | **PostgreSQL `team_notes`** | `/api/team-notes` |
| Calendar of record (patient-facing slots) | **Cal.com** | Public embed on `/book/:slug`; inbound webhook writes `bookings` |
| Ephemeral rate limits | **Redis** (Upstash REST, optional) | Login throttling in `auth-crypto.js` |
| Staff session identity | **httpOnly JWT cookie `dentaflow_session`** | All authenticated `/api/*` handlers |

**Rules of engagement:**

- Do **not** treat Baserow, Google Sheets, or n8n static data as SSOT. Those prototype paths are deprecated.
- Do **not** query across clinics. Every operational `SELECT`/`INSERT`/`UPDATE` binds `clinic_id` from the JWT (or from `clinics.slug` on public routes).
- Do **not** store JWTs in `localStorage`. The only session credential is the httpOnly `dentaflow_session` cookie.
- Do **not** return database URLs, pool stats, or credentials from `/api/health` or any public handler.

### 1.2 Core objectives

1. **Multi-clinic tenancy** — one Supabase project, many rows in `clinics`, isolation via `clinic_id`.
2. **Zero-friction public booking** — `/book/:slug` is themed from `/api/public/clinic/:slug` and embeds Cal.com.
3. **Staff operations on Postgres** — roster, waitlist, KPIs, notes, and status updates read/write PostgreSQL through Vercel serverless functions.
4. **Cal.com as the patient calendar** — bookings enter the OS through `POST /api/webhooks/cal` into `bookings`.

---

## 2. Infrastructure & Component Stack

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Clients                                                                 │
│  • Doctor shell (index.html)                                             │
│  • Assistant shell (assistant-shell.html)                                │
│  • Public booking portal (/book/:slug → book.html)                       │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ HTTPS + cookie JWT            │ no auth
                ▼                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Vercel — Temara_Dashboard                                               │
│  Static UI + serverless /api/*                                           │
│  /api/auth  /api/roster  /api/waitlist  /api/dashboard-data              │
│  /api/public/clinic/:slug  /api/webhooks/cal  /api/health                │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ DATABASE_URL (pooler :6543)   │ Cal.com embed + webhook
                ▼                               ▼
         Supabase PostgreSQL              Cal.com (calendar)
         clinics, staff_users,            HMAC optional
         bookings, waitlist,              CALCOM_WEBHOOK_SECRET
         team_notes
```

### 2.1 Frontend — Vercel static clinic OS

- **Host:** Vercel (static assets + Node serverless functions under `Temara_Dashboard/api/`).
- **Staff surfaces:**
  - **Doctor** — `index.html` + `dashboard_app.js`
  - **Assistant** — `assistant-shell.html` + `app.js`
- **Public surface:** `/book/:slug` rewrites to `book.html` + `book.js` (no JWT).
- **Auth client:** `auth.js` (`window.DentaFlowAuth`) posts to `/api/auth` with `credentials: 'include'`. The JWT is **not** a Bearer token the UI stores; it is set as `dentaflow_session` (httpOnly, Secure, SameSite=Lax).
- **Password rotation:** settings form in `shared.js` posts to `/api/auth/password`.
- **Frontend never holds database or Twilio secrets** — privileged work stays in `/api/*`.

### 2.2 API — Vercel serverless on PostgreSQL

Operational handlers in `Temara_Dashboard/api/` use `api/_lib/db.js` (`pg` Pool, `DATABASE_URL`) and `requireClinicSession` from `api/_lib/validation.js`. Clinic scope is always `session.clinic_id`.

| Route | Role |
| --- | --- |
| `POST /api/auth` | Login against `staff_users` + `clinics.slug` |
| `POST /api/auth/me` | Session probe |
| `POST /api/auth/logout` | Clear `dentaflow_session` |
| `POST /api/auth/password` | scrypt rotate `staff_users.password_hash` |
| `GET /api/roster` | Today's `bookings` for the clinic |
| `GET`/`POST /api/waitlist` | Clinic waitlist |
| `GET /api/dashboard-data` | KPI aggregations on today's `bookings` |
| `GET /api/public/clinic/:slug` | Public theme + Cal.com event type (no secrets) |
| `POST /api/webhooks/cal` | Cal.com → `bookings` upsert/cancel |
| `GET /api/health` | `SELECT 1` liveness, sanitized JSON |

Remaining `N8N_WEBHOOK_*` proxies (`/api/n8n-proxy`, `/api/bulk-sms`, `/api/proxy`, …) are **legacy bridges**. They are non-blocking: missing n8n env must not take down Postgres-backed ops.

### 2.3 Primary database — Supabase PostgreSQL

- **One database, many clinics.** Production `DATABASE_URL` is the Supabase **transaction pooler (port 6543)**.
- **Tenant key:** `clinics.id` (UUID). Child tables (`staff_users`, `bookings`, `waitlist`, `team_notes`) reference `clinic_id` with `ON DELETE CASCADE`.
- **Staff:** `staff_users.username` is unique per clinic. Roles are `doctor` \| `assistant`. Passwords are scrypt hashes (`scrypt$<salt>$<derived>`).
- **Access:** parameterized SQL only (`query(text, params)`). No string-concatenated identifiers.

### 2.4 Caching / locking — Redis (optional)

Redis is **not** the session store and **not** the patient database. When configured, Upstash REST is used only for login rate limiting (`auth-crypto.js`). If Redis is absent, login rate limiting fails open.

---

## 3. Data Flows & External Services

### 3.1 Authentication flow

```
Browser  POST /api/auth  { username, password, slug? }
    │
    ▼
staff_users ⋈ clinics  WHERE lower(username)=lower($1) AND clinics.slug=$2
    │
    ├─ verifyPassword(password, password_hash)   // scrypt, timing-safe
    ├─ signJwt({ sub, role, clinic_id, slug })   // HS256, JWT_SECRET
    └─ Set-Cookie: dentaflow_session=<jwt>; HttpOnly; Secure; SameSite=Lax
```

JWT claims:

| Claim | Meaning |
| --- | --- |
| `sub` | `staff_users.id` (UUID) |
| `role` | `doctor` or `assistant` |
| `clinic_id` | `clinics.id` (UUID) — **tenant scope for every subsequent query** |
| `slug` | `clinics.slug` (e.g. `temara`) |

Protected handlers call `requireClinicSession(req, res)` which reads the cookie (not a required `Authorization` header), verifies the JWT, and returns `{ sub, role, clinic_id, slug }`.

Password change (`POST /api/auth/password`) re-reads `password_hash` for `id = sub AND clinic_id = $clinic_id`, verifies the current password, hashes the new one with `hashPassword`, and updates that row only.

### 3.2 Cal.com webhook → bookings

```
Cal.com (BOOKING_CREATED | BOOKING_RESCHEDULED | BOOKING_CANCELLED)
    │  POST /api/webhooks/cal
    │  optional HMAC  X-Cal-Signature-256  + CALCOM_WEBHOOK_SECRET
    ▼
Resolve clinic_id (event type / slug, fallback clinics.slug = 'temara')
    │
    ├─ CREATED     → INSERT bookings … ON CONFLICT (cal_booking_uid) DO UPDATE
    ├─ RESCHEDULED → UPDATE bookings SET starts_at, duration_min
    └─ CANCELLED   → UPDATE bookings SET status = 'Annule'
```

The public portal does **not** write `bookings` directly. Patients book on Cal.com; the webhook is the ingest path.

### 3.3 Public booking portal

```
GET /book/:slug          → book.html  (Vercel rewrite)
GET /api/public/clinic/:slug
    │
    ▼
clinics WHERE slug = $1
    │  returns name, slug, phone, themePreset, themeTokens, calEventTypeId
    │  never returns clinic UUID, DATABASE_URL, Twilio numbers, or hashes
    ▼
book.js applies CSS tokens and embeds https://app.cal.com / https://cal.com
```

### 3.4 Staff operational reads/writes

All of the following filter or insert with `clinic_id` from the JWT:

- Roster — today's `bookings` in `Africa/Casablanca`
- Dashboard KPIs — counts by `appointment_status`
- Waitlist — `waitlist` rows with `waitlist_priority` (`Faible` \| `Moyenne` \| `Haute` \| `Urgent`)
- Fill-gap / lead-capture — waitlist candidates / intake
- Team notes — `team_notes` scoped to the clinic
- Status updates — `bookings.status` for the clinic

---

## 4. Security & Authentication Architecture

### 4.1 Cookie session (not Bearer-in-sessionStorage)

- **Cookie name:** `dentaflow_session` (single cookie for both roles).
- **Flags:** HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age ≈ 8h.
- **Logout:** `POST /api/auth/logout` expires `dentaflow_session` (and the legacy `dentaflow_session_ast` name if present).
- Frontend `sessionStorage` may still remember **role for UI routing**; it is not the credential.

**Anti-cascade rule:** HTTP 401 from a protected API is session death (`DentaFlowAuth.logout`), never “Mode dégradé” empty clinic data.

### 4.2 HTTP security headers (`Temara_Dashboard/vercel.json`)

Global (`/(.*)`):

- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-Frame-Options: DENY` on staff surfaces (`/`, `/index.html`, `/assistant-shell.html`)
- CSP allows Cal.com scripts/frames and Supabase `connect-src`; staff pages set `frame-ancestors 'none'`

Public booking (`/book.html`, `/book/:slug`):

- `X-Frame-Options: SAMEORIGIN` (overrides DENY so the Cal.com embed can run in-page)
- CSP `frame-src 'self' https://app.cal.com https://cal.com`

### 4.3 Health endpoint

`GET /api/health` runs `query('SELECT 1')` and returns only `{ ok, status, database, timestamp }`. Non-GET → 405. Failures → 503 `degraded` / `disconnected`. No URLs, pool sizes, or error strings.

### 4.4 Trust boundaries

```
Untrusted: Browser, public /book/:slug, Cal.com webhooks, /api/health
Semi-trusted: Vercel serverless (holds DATABASE_URL + JWT_SECRET; validates cookie)
SSOT: Supabase PostgreSQL (clinic-scoped rows)
Calendar ingest: Cal.com → /api/webhooks/cal
Optional: Upstash Redis (login rate limit only)
```

---

## 5. Deprecated prototype components

Moved to `_attic/` — **do not deploy**, do not point DNS here:

| Path | Why retired |
| --- | --- |
| `_attic/Temara_Assistant_Dashboard/` | PIN-era assistant console; separate app that talked to n8n/ngrok |
| `_attic/README.md` | Notes that this tree is not a Vercel project |

**Deprecated references (non-blocking, do not restore as SSOT):**

- `BASEROW_*` — old waitlist/patient REST API
- `N8N_WEBHOOK_*` / `N8N_AUTH_KEY` — dashboard used to proxy every mutation through n8n
- Google Sheets “Calculs” KPI path
- `DOCTOR_PASSWORD_HASH` / `ASSISTANT_PASSWORD_HASH` env logins — replaced by `staff_users.password_hash`
- JWT in `sessionStorage` as the access token — replaced by httpOnly `dentaflow_session`
- Settings passwords in `localStorage` (`df_pwd_doc` / `df_pwd_asst`)

Live environment variable policy is in `ENV_LEDGER.md`.

---

## Appendix A — Key repository paths

| Path | Role |
| --- | --- |
| `Temara_Dashboard/` | Production clinic UI + Vercel APIs |
| `Temara_Dashboard/api/_lib/db.js` | `pg` pool, `DATABASE_URL` |
| `Temara_Dashboard/api/_lib/auth-crypto.js` | scrypt, JWT, cookie, optional Redis limiter |
| `Temara_Dashboard/api/_lib/validation.js` | `requireClinicSession`, API errors |
| `Temara_Dashboard/api/auth.js` | Login / me / logout / password routing |
| `Temara_Dashboard/api/webhooks/cal.js` | Cal.com → `bookings` |
| `Temara_Dashboard/api/public/clinic.js` | Public tenant branding |
| `Temara_Dashboard/api/health.js` | Sanitized DB probe |
| `Temara_Dashboard/vercel.json` | Rewrites + security headers / CSP |
| `Temara_Dashboard/book.html` / `book.js` | Public Cal.com portal |
| `_attic/` | Deprecated prototypes |

## Appendix B — Operational invariants

1. **Tenant isolation = `clinic_id` on every operational row.**
2. **Staff auth = `staff_users` + scrypt + `dentaflow_session`.**
3. **Calendar ingest = Cal.com webhook → `bookings`.**
4. **Public portal = `/book/:slug` + `/api/public/clinic/:slug` (no JWT, no secrets).**
5. **401 = logout**, never a degraded empty dashboard.
6. **Secrets never in static JS** and never in `/api/health`.

---

*End of document — DentaFlow OS System Architecture*
