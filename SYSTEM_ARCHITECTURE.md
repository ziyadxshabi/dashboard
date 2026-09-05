# DentaFlow OS — System Architecture

> **Classification:** Internal developer reference
> **Runtime:** Supabase PostgreSQL + Vercel serverless (`Temara_Dashboard`)
> **Last aligned to codebase:** 2026-09-05

This document describes the **active** production architecture. Baserow, Google Sheets, ngrok, and n8n proxies are not sources of truth and are not part of the runtime path.

---

## 1. System overview

DentaFlow OS is a **multi-tenant clinic operating system** for dental practices.

- **One PostgreSQL database** (Supabase) stores every durable operational fact.
- **One Vercel project** (`Temara_Dashboard`) serves the staff UI, the public booking portal, and Node serverless APIs.
- **Tenant isolation** is `clinic_id` on every child row — never a database per clinic.
- **Cal.com** is the patient-facing calendar. Inbound webhooks write `bookings`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Staff browser  GET /          Public patient  GET /book/:slug          │
│  Doctor + assistant shells     book.html + book.js (no JWT)             │
│  Role-gated from one origin    Cal.com embed after clinic hydration     │
└──────────────┬───────────────────────────────┬──────────────────────────┘
               │ cookie JWT                    │ public JSON
               ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Vercel — Temara_Dashboard (static + serverless /api/*)                 │
│                                                                         │
│  Auth     POST /api/auth   GET|POST /api/auth/me   POST /api/auth/logout│
│  Ops      GET /api/roster  PATCH status  GET|POST /api/waitlist         │
│           POST /api/fill-gap  POST /api/bulk-sms  GET|POST /api/team-notes│
│           GET /api/dashboard-data                                       │
│  Public   GET /api/public/clinic/:slug   GET /api/health                │
│  Ingest   POST /api/webhooks/cal                                        │
└──────────────┬───────────────────────────────┬──────────────────────────┘
               │ DATABASE_URL :6543            │ HMAC optional
               ▼                               ▼
        Supabase PostgreSQL                 Cal.com
        clinics, staff_users,               BOOKING_CREATED
        bookings, waitlist,                 BOOKING_RESCHEDULED
        team_notes, sms_dispatch_log        BOOKING_CANCELLED
```

**Rules:**

- Do not treat Baserow, Google Sheets, or n8n as SSOT.
- Do not query across clinics. Bind `clinic_id` from the JWT (or `clinics.slug` on public routes).
- Do not store JWTs in `localStorage`. The credential is httpOnly `dentaflow_session`.
- Do not return `DATABASE_URL`, pool stats, Twilio numbers, password hashes, or clinic UUIDs from public handlers.

---

## 2. Surfaces

### 2.1 Unified role-gated UI — `GET /`

Staff use a **single origin** (`index.html` + `auth.js`). After `POST /api/auth`:

| Role | Shell | Client |
| --- | --- | --- |
| `doctor` | Doctor dashboard in `index.html` | `dashboard_app.js` |
| `assistant` | `assistant-shell.html` (loaded into the same page) | `app.js` |

`GET /api/auth/me` hydrates `{ user, clinic }` (name, `theme_preset`, `theme_tokens`). HTTP 401 is session death (`DentaFlowAuth.logout`), never an empty “degraded” clinic.

The PIN-era assistant app lives in `_attic/Temara_Assistant_Dashboard/` and is **not deployed**.

### 2.2 Public patient booking — `GET /book/:slug`

`Temara_Dashboard/vercel.json` rewrites `/book` and `/book/:slug` to `book.html`.

1. `book.js` extracts the slug (`/book/temara` → `temara`, default `temara`).
2. `GET /api/public/clinic/:slug` returns name, phone, theme, `calEmbedUrl` — **no clinic UUID, no Twilio, no hashes**.
3. The page title, header, and CSS tokens update; Cal.com mounts from `cal_embed_url` or `cal_event_type_id`.

Patients never write `bookings` from this page. Cal.com does; `/api/webhooks/cal` ingests.

---

## 3. Multi-tenant data model

Canonical SQL: `supabase/schema.sql`. Access: `Temara_Dashboard/api/_lib/db.js` (`pg` Pool, parameterized queries only).

**Tenant key:** `clinics.id` (UUID). Child tables use `clinic_id … ON DELETE CASCADE`.

| Table | Role |
| --- | --- |
| `clinics` | Slug, display name, phone, `theme_preset`, `theme_tokens`, Cal.com event type, SMS booking URL |
| `staff_users` | Per-clinic unique `username`, scrypt `password_hash`, role `doctor` \| `assistant`, `display_name` |
| `bookings` | Appointments (`cal_booking_uid`, patient, `appointment_status`, `starts_at`) |
| `waitlist` | Active / filled candidates, `waitlist_priority` |
| `team_notes` | Clinic-scoped notes (`author_name` / `content`, `pinned`, `category`) |
| `sms_dispatch_log` | Bulk SMS audit rows (message, recipient count, JSON recipients) |

Enums:

- `appointment_status`: `Confirme`, `En attente`, `En salle d'attente`, `En soin`, `Termine`, `No-show`, `Annule`
- `waitlist_priority`: `Faible`, `Moyenne`, `Haute`, `Urgent`
- `staff_role`: `doctor`, `assistant`

Seed clinic slug: `temara` (Clinique Dentaire Témara Mall). Seed usernames in SQL: `docteur`, `assistante` (login also accepts `doctor` / `assistant`).

---

## 4. Vercel serverless APIs

Handlers under `Temara_Dashboard/api/` (Hobby cap 12 functions). `_lib/` and `_archive/` are not deployed as routes.

| Route | Auth | Store |
| --- | --- | --- |
| `POST /api/auth` | Public | `staff_users` ⋈ `clinics` |
| `GET` / `POST /api/auth/me` | Cookie | Staff + clinic hydration |
| `POST /api/auth/logout` | Cookie | Expire `dentaflow_session` |
| `POST /api/auth/password` | Cookie | Rotate `password_hash` |
| `GET /api/roster` | Cookie | Today's `bookings` (`Africa/Casablanca`) |
| `POST /api/update-status` / `PATCH /api/roster` | Cookie | Direct `bookings.status` update |
| `GET` / `POST /api/waitlist` | Cookie | `waitlist` |
| `POST /api/fill-gap` | Cookie | Waitlist candidates; optional `bookings` insert |
| `POST /api/bulk-sms` | Cookie | `sms_dispatch_log` (no n8n) |
| `GET` / `POST /api/team-notes` | Cookie | `team_notes` |
| `GET /api/dashboard-data` | Cookie | KPI aggregations on `bookings` |
| `GET /api/public/clinic/:slug` | None | Public clinic branding |
| `POST /api/webhooks/cal` | HMAC optional | Cal.com → `bookings` |
| `GET /api/health` | None | `SELECT 1` — `{ ok, status, database, timestamp }` only |

Clinic scope for staff routes: `requireClinicSession` → `session.clinic_id`.

---

## 5. Authentication

### 5.1 Password verification (scrypt)

Stored as `scrypt$<salt-b64>$<derived-b64>` (`api/_lib/auth-crypto.js`). Login and password change use `verifyPassword` / `hashPassword` (timing-safe compare). Env hashes (`DOCTOR_PASSWORD_HASH`, …) are **not** used.

### 5.2 Session cookie

```
Browser  POST /api/auth  { username, password, slug? }
    │
    ▼
staff_users ⋈ clinics
    ├─ bilingual username aliases (see below)
    ├─ verifyPassword  →  scrypt
    ├─ signJwt({ sub, role, clinic_id, slug })  →  HS256, JWT_SECRET
    └─ Set-Cookie: dentaflow_session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age≈8h
```

| JWT claim | Meaning |
| --- | --- |
| `sub` | `staff_users.id` |
| `role` | Canonical `doctor` or `assistant` |
| `clinic_id` | `clinics.id` — tenant scope for every later query |
| `slug` | `clinics.slug` (e.g. `temara`) |

`GET /api/auth/me` re-reads staff + clinic and returns `{ ok, user, clinic }`. Logout expires `dentaflow_session` (and legacy `dentaflow_session_ast` if present).

### 5.3 Bilingual aliases

Canonical DB roles remain `doctor` and `assistant`. Login accepts French and English usernames **and** role labels:

| Input | Resolved username lookup | Canonical role |
| --- | --- | --- |
| `doctor` / `docteur` | `doctor`, `docteur` | `doctor` |
| `assistant` / `assistante` | `assistant`, `assistante` | `assistant` |

Seeded local password: `dentaflow` (see `scripts/setup-dev-env.sh` / handler tests).

### 5.4 Optional Redis rate limit

Login throttling uses Upstash REST (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`). If Redis is unset or down, limiting **fails open**. Redis is not the session store.

---

## 6. Direct PostgreSQL status updates

`POST /api/update-status` and `PATCH /api/roster` (`api/_lib/update-booking-status.js`):

- Require `dentaflow_session` (`doctor` or `assistant`).
- Validate status codes (`confirme`, `en_attente`, `en_salle`, `en_soin`, `termine`, `no_show`, `annule`) and map to `appointment_status`.
- `UPDATE bookings SET status = $1, updated_at = NOW() WHERE clinic_id = $2 AND (id = $3 OR cal_booking_uid = $3)`.
- Cross-clinic IDs → 404. Invalid status → 400. `annule` also sets `triggerCalCancel: true` for the client.

No n8n, Baserow, or Sheets write path.

---

## 7. Cal.com webhook synchronization

`POST /api/webhooks/cal` (`Temara_Dashboard/api/webhooks/cal.js`):

```
Cal.com  BOOKING_CREATED | BOOKING_RESCHEDULED | BOOKING_CANCELLED
    │  optional HMAC  X-Cal-Signature-256  + CALCOM_WEBHOOK_SECRET
    ▼
Resolve clinic_id (event type / slug, fallback clinics.slug = 'temara')
    │
    ├─ CREATED     → INSERT bookings … ON CONFLICT (cal_booking_uid) DO UPDATE
    │                status Confirme
    ├─ RESCHEDULED → UPDATE starts_at, status Confirme, updated_at
    └─ CANCELLED   → UPDATE status Annule, updated_at
```

When `CALCOM_WEBHOOK_SECRET` is set, unsigned payloads are rejected. When unset (local), unsigned payloads are accepted for development.

---

## 8. Security headers

`Temara_Dashboard/vercel.json`:

- Global: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`
- Public booking must allow Cal.com iframes (`app.cal.com`, `cal.com`)

Trust boundaries: public `/book/:slug` and webhooks are untrusted; serverless holds `DATABASE_URL` and `JWT_SECRET`; PostgreSQL is SSOT.

---

## 9. Deprecated prototype components

Do **not** deploy, restore as SSOT, or document as the live stack:

| Item | Status |
| --- | --- |
| `_attic/Temara_Assistant_Dashboard/` | PIN-era n8n/ngrok assistant console |
| `Temara_Dashboard/api/_archive/` | Old n8n proxies (`n8n-proxy`, `bulk-sms` webhook, …) |
| Baserow REST + Google Sheets “Calculs” | Prototype waitlist / KPI path |
| `N8N_WEBHOOK_*`, `N8N_AUTH_KEY`, ngrok URLs | Deprecated |
| Env `DOCTOR_PASSWORD_HASH` / PIN logins | Replaced by `staff_users` |
| JWT in `sessionStorage` as the access token | Replaced by httpOnly cookie |

Environment policy: `ENV_LEDGER.md`.

---

## Appendix — Key paths

| Path | Role |
| --- | --- |
| `Temara_Dashboard/` | Production UI + Vercel APIs (set as Vercel Root Directory) |
| `Temara_Dashboard/api/_lib/db.js` | `pg` pool |
| `Temara_Dashboard/api/_lib/auth-crypto.js` | scrypt, JWT, cookie, optional Redis |
| `Temara_Dashboard/api/_lib/validation.js` | `requireClinicSession`, validators |
| `Temara_Dashboard/api/auth.js` | Login / me / logout / password |
| `Temara_Dashboard/api/webhooks/cal.js` | Cal.com ingest |
| `Temara_Dashboard/api/public/clinic/[slug].js` | Public branding |
| `supabase/schema.sql` | Canonical schema + Temara seed |
| `scripts/dev-server.js` | Local Vercel-like server |
| `scripts/test-handlers-direct.js` | `npm test` |
| `_attic/` | Retired prototypes |

**Invariants:** tenant isolation = `clinic_id`; staff auth = scrypt + `dentaflow_session`; calendar ingest = Cal.com webhook; public portal never sees secrets; 401 = logout.

---

*End of document — DentaFlow OS System Architecture*
