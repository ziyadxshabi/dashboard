# DentaFlow OS

Multi-tenant clinic operating system for dental practices: staff roster, waitlist, team notes, KPIs, and a public Cal.com booking portal.

**Source of truth:** Supabase PostgreSQL.
**Runtime:** Vercel static UI + Node serverless functions in `Temara_Dashboard/`.

This is not a Baserow, Google Sheets, or n8n application. Those prototype paths are retired (`_attic/`, `api/_archive/`). See `SYSTEM_ARCHITECTURE.md` and `ENV_LEDGER.md`.

---

## Operational features

- **Unified staff UI** at `/` — one login gate; `doctor` and `assistant` shells after `dentaflow_session` is set.
- **Public booking** at `/book/:slug` — clinic theme + Cal.com embed, no JWT.
- **Direct PostgreSQL APIs** — roster, waitlist, fill-gap, team notes, dashboard KPIs, bulk-SMS audit log, status updates.
- **Cal.com sync** — `POST /api/webhooks/cal` upserts and cancels `bookings`.
- **Cookie auth** — scrypt password hashes in `staff_users`, HS256 JWT in httpOnly `dentaflow_session`. Usernames/roles accept `docteur`/`doctor` and `assistante`/`assistant`.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| UI | Static HTML/CSS/JS (`Temara_Dashboard/`) |
| Hosting | Vercel (Root Directory: `Temara_Dashboard`) |
| API | Node.js serverless handlers (`Temara_Dashboard/api/*.js`) |
| Database | Supabase PostgreSQL (transaction pooler **port 6543**) |
| Calendar | Cal.com (embed + webhook) |
| Optional limiter | Upstash Redis REST |
| Tests | `scripts/test-handlers-direct.js` via `npm test` |

---

## Installation

```bash
git clone https://github.com/ziyadxshabi/dashboard.git
cd dashboard
npm install
bash scripts/setup-dev-env.sh
```

`setup-dev-env.sh` is idempotent. It installs root dependencies and creates `Temara_Dashboard/.env.local` when missing (local `JWT_SECRET` + `DATABASE_URL` pointing at `127.0.0.1:5432`).

For **Supabase** (typical cloud/dev against production-like data), put the pooler URL in `Temara_Dashboard/.env.local`:

```text
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres
JWT_SECRET=<at-least-32-chars>
CLINIC_ID=temara
```

Optional: `CALCOM_WEBHOOK_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Full list: `ENV_LEDGER.md`.

Start the local server (Vercel-like static + `/api` dispatch):

```bash
node scripts/dev-server.js
```

Open [http://localhost:3000](http://localhost:3000). Seeded logins (if `staff_users` is seeded):

| Role | Username | Password |
| --- | --- | --- |
| Doctor | `docteur` or `doctor` | `dentaflow` |
| Assistant | `assistante` or `assistant` | `dentaflow` |

Public portal: [http://localhost:3000/book/temara](http://localhost:3000/book/temara).

---

## Database migrations

Canonical schema and Temara seed: **`supabase/schema.sql`**.

Apply to an empty database (local or Supabase SQL editor):

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

The file is idempotent (`CREATE … IF NOT EXISTS`, enum `duplicate_object` guards, `ON CONFLICT DO NOTHING` seeds).

Tables: `clinics`, `staff_users`, `bookings`, `waitlist`, `team_notes`, `sms_dispatch_log`.

Handlers also add missing columns defensively where needed (`bookings.updated_at`, `team_notes.pinned` / `category`, `sms_dispatch_log`). Prefer applying `schema.sql` in production rather than relying on first-request `ALTER`s.

---

## Tests

From the **repository root**:

```bash
npm test
```

This runs `node scripts/test-handlers-direct.js` against PostgreSQL using `DATABASE_URL` and `JWT_SECRET` from `.env.local`. Expect **130 passed, 0 failed**.

HTTP smoke against the local server (spawns `scripts/dev-server.js` if port 3000 is down):

```bash
npm run smoke
```

The dashboard package forwards the same commands (`Temara_Dashboard/package.json` → `../scripts/…`).

---

## Deploying to Vercel

1. Import `https://github.com/ziyadxshabi/dashboard`.
2. Set **Root Directory** to `Temara_Dashboard`.
3. Framework preset: Other. No build command is required (static files + `/api` serverless).
4. Configure Production (and Preview) env:

   | Name | Required |
   | --- | --- |
   | `DATABASE_URL` | Yes (pooler `:6543`) |
   | `JWT_SECRET` | Yes |
   | `CLINIC_ID` | `temara` unless you change the default slug |
   | `CALCOM_WEBHOOK_SECRET` | Yes in production |
   | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Optional |

5. Point Cal.com’s webhook to `https://<your-domain>/api/webhooks/cal`.
6. Stay under the Vercel Hobby **12 serverless function** limit (`api/_lib` and `api/_archive` do not count as routes).

Do not deploy `_attic/`.

---

## Repository map

| Path | Purpose |
| --- | --- |
| `Temara_Dashboard/` | Production app (Vercel root) |
| `Temara_Dashboard/api/` | Serverless handlers |
| `supabase/schema.sql` | Schema + seed |
| `scripts/dev-server.js` | Local server |
| `scripts/test-handlers-direct.js` | Direct handler tests |
| `SYSTEM_ARCHITECTURE.md` | Runtime architecture |
| `ENV_LEDGER.md` | Environment variables |
| `_attic/` | Deprecated PIN-era assistant UI |

---

## License

ISC. See `package.json`.
