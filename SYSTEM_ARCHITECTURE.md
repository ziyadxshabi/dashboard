# DentaFlow OS — System Architecture

> **Classification:** Internal developer reference  
> **Scope:** Booking, operations, messaging, auth, and automation for the Temara dental clinic stack  
> **Last aligned to codebase:** production dashboard (`Temara_Dashboard`), n8n workflow exports (`n8n/`), Vercel serverless proxies

---

## 1. System Overview & Core Philosophy

### 1.1 Single Source of Truth (SSOT)

DentaFlow OS enforces a strict **Single Source of Truth** protocol: every durable fact about a patient, slot, or operational event is owned by **one** authoritative store, and every other surface (dashboard, SMS, Slack, IVR) is a **projection** or **side effect** of that store.

| Domain | Authoritative store | Consumers (read-only / derived) |
|--------|---------------------|----------------------------------|
| Appointments / calendar | **Cal.com** | Concierge workflows, dashboard roster proxies, Slack alerts |
| Patients, waitlist, broadcast logs | **Baserow** (PostgreSQL-backed relational tables) | Waitlist cascade, SMS confirmation paths, slot-filled cleanup |
| Operational KPIs (selected metrics) | **Google Sheets** (Calculs tab) via n8n | Doctor dashboard charts |
| Ephemeral concurrency / rate limits / dedup | **Redis** (Upstash REST) | Booking locks, login throttling, Twilio/webhook dedup, error-monitor dedup |
| Staff session identity | **JWT** issued by `/api/auth` (not stored server-side) | Frontend shells, Vercel API proxies |

**Rules of engagement:**

- Do **not** invent a second booking calendar outside Cal.com.
- Do **not** keep waitlist state in n8n static data or in-memory Code-node variables across executions.
- Do **not** use Redis for permanent patient or schedule records — locks and counters only.
- Dashboard UIs must never treat a failed auth response as “empty clinic data” (see §4).

### 1.2 Core Objectives

1. **Zero-friction booking** — Patients book via Cal.com (web), Twilio Voice IVR (“Press 1 to book”), or staff-assisted flows; all paths converge on the same calendar and confirmation pipeline.
2. **Automated revenue recovery (waitlist cascade)** — Cancellations / free slots trigger Baserow-backed waitlist outreach (Twilio SMS/WhatsApp) and Slack staff routing until the slot is filled or the cascade completes.
3. **Cryptographic double-booking prevention** — Millisecond-scale mutual exclusion via Redis `SET key 1 NX EX <ttl>` (Upstash REST) before mutating shared slot state; webhook authenticity via HMAC (Cal.com, Twilio) and timing-safe comparisons in n8n Code nodes (`crypto`).

---

## 2. Infrastructure & Component Stack

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Clients                                                                 │
│  • Doctor shell (index.html)  • Assistant shell (assistant-shell.html) │
│  • Patient portal / lead capture                                         │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ HTTPS + Bearer JWT
┌─────────────────────────────▼────────────────────────────────────────────┐
│  Vercel — Temara_Dashboard                                               │
│  Static UI + serverless /api/* proxies                                   │
│  /api/auth  /api/roster  /api/dashboard-data  /api/waitlist  …           │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ x-agency-auth / webhook POST|GET
┌─────────────────────────────▼────────────────────────────────────────────┐
│  n8n — Automation engine                                                 │
│  Concierge • Waitlist • Twilio Voice • Dashboard • Bulk SMS • Errors     │
└───┬───────────┬───────────┬───────────┬───────────┬──────────────────────┘
    │           │           │           │           │
    ▼           ▼           ▼           ▼           ▼
 Cal.com     Baserow      Redis      Twilio       Slack
 (bookings)  (Postgres    (locks)    (SMS/WA/    (staff)
              tables)                 Voice)
```

### 2.1 Frontend — Cloud-hosted clinic dashboard

- **Host:** Vercel (static assets + Node serverless functions under `Temara_Dashboard/api/`).
- **Surfaces:**
  - **Doctor** — `index.html` + `dashboard_app.js` (Oak Lounge KPIs, charts, operational controls).
  - **Assistant** — `assistant-shell.html` + `app.js` (roster, fill-gap SMS, day-of ops).
- **Auth client:** `auth.js` (`window.DentaFlowAuth`) — JWT in `sessionStorage` (`dentaflow_session`, `dentaflow_role`); login overlay on the same page (no separate `login.html`).
- **UX constraints:** Dark-mode, mobile-responsive layout; mobile logout dock; role toggle (Médecin / Assistant(e)).
- **Design note:** Frontend never holds n8n webhook secrets — all privileged calls go through `/api/*` proxies.

### 2.2 Backend / Engine — n8n

n8n owns **all** automated workflows, inbound webhooks, and API bridging:

| Workflow family (repo export) | Responsibility |
|-------------------------------|----------------|
| `Production Concierge Engine v2` | Cal.com book/cancel → Baserow + Twilio confirmations + Slack + Redis locks + waitlist slot-filled cleanup |
| `No-Show Waitlist Engine` | Waitlist cascade / no-show recovery |
| `Twilio Voice Menu v4.90` | Inbound IVR (“Press 1…”), signature validation, Redis rate limits |
| `Dashboard Data Endpoint` / `Workflow 1–5` | Dashboard KPI pull, roster, bulk confirm, status updates |
| `Agency Master Error Monitor` | Slack-facing error routing with Redis dedup |
| `Superpouvoir_*` | Urgency slot block (Cal.com), force SMS |

**n8n Code nodes** require Node built-in `crypto` (see §5.1). Prefer `$vars['KEY'] ?? $env['KEY']` for configuration.

### 2.3 Primary database — PostgreSQL (via Baserow)

- **Logical model:** Relational tables for patients, waitlist membership, broadcast/notification logs, and related clinic records.
- **Access pattern in production today:** **Baserow REST API** (`BASEROW_API_URL`, `BASEROW_API_TOKEN`, table IDs). Baserow’s persistence layer is PostgreSQL; DentaFlow does not currently open a raw `DATABASE_URL` from the dashboard or n8n Code nodes for CRUD.
- **SSOT implication:** Waitlist cascade state is **Baserow-backed** (no in-memory n8n state). Slot-filled cleanup reads notified phones for a slot from Baserow, then messages remaining waitlist candidates via Twilio.

> If a direct PostgreSQL connection string is introduced later (analytics, audit archive), keep Baserow/Cal.com as the write path for operational facts unless a formal migration plan reassigns SSOT ownership.

### 2.4 Caching / Locking — Redis (Upstash)

Redis is used **exclusively** for short-lived coordination — **not** as a patient database:

| Use case | Pattern |
|----------|---------|
| Double-booking / slot mutex | `SET <key> 1 NX EX <ttl>` via Upstash REST |
| Login brute-force limit | Increment + TTL window (`auth-crypto.js` + Redis REST) |
| Webhook / SMS status dedup | `SET NX` with short TTL |
| Twilio Voice rate limit | Sliding window increment |
| Error monitor spam control | Dedup key `errmon:dedup:*` (~300s) |

**Required env:** `REDIS_CONNECTION_URL` (Upstash REST base URL), `REDIS_REST_TOKEN` (Bearer).

Shared helper: `n8n/_snippets/redis_upstash.js` (and inlined equivalents in workflow JSON).

---

## 3. Data Flows & External Services

### 3.1 Cal.com — Inbound bookings & cancellations

```
Patient / IVR / Staff
        │
        ▼
    Cal.com (SSOT calendar)
        │  webhook (HMAC-SHA256, CAL_WEBHOOK_SECRET)
        ▼
n8n Concierge — Validate Cal.com Auth
        │
        ├─► Baserow upsert / status
        ├─► Twilio confirmation SMS
        ├─► Slack staff notification (cancel / SMS failure)
        └─► Redis lock + waitlist cleanup when slot filled
```

- **Outbound from n8n:** Cal.com REST with `CALCOM_API_KEY` / `CALCOM_EVENT_TYPE_ID` (e.g. Superpouvoir urgency block).
- **Inbound security:** Timing-safe HMAC verification of webhook signature in Concierge Code nodes (`require('crypto')`).

### 3.2 Twilio — Outbound messaging & inbound voice

**Outbound**

- Confirmation SMS after booking.
- Waitlist cascade / fill-gap / bulk SMS / post-op or review sequences (workflow-dependent).
- Delivery status callbacks → signature validation → Baserow status update (deduped in Redis).

**Inbound Voice IVR** (`Twilio Voice Menu`)

- Twilio posts to n8n webhook.
- Validate `X-Twilio-Signature` with `N8N_TWILIO_AUTH_TOKEN` + `N8N_WEBHOOK_BASE_URL`.
- Redis rate limiting.
- Menu path: e.g. **Press 1 to book** → handoff into Cal.com booking flow / clinic routing.

**WhatsApp / Meta channel**

- Clinic messaging may ride **Twilio’s WhatsApp/SMS APIs** (Twilio Account SID + From number + Auth Token). Meta Business credentials, when used, sit behind the Twilio/WhatsApp sender configuration — keep Meta App secrets in the Twilio/Meta console, not in the static frontend.

### 3.3 Slack — Internal clinic routing

- Cancellation alerts (“créneau libéré”).
- SMS delivery failure alerts (Baserow write succeeded, SMS failed → manual follow-up).
- Agency error monitor notifications (deduped).

Slack is **never** SSOT — it is a staff notification bus only.

### 3.4 Dashboard ↔ n8n bridge (Vercel)

Browser → `Authorization: Bearer <JWT>` → Vercel `/api/*` → n8n webhook with `x-agency-auth` (and related keys).

| Proxy (representative) | Env webhook / auth |
|------------------------|--------------------|
| `/api/auth` | `JWT_SECRET`, role username/hash pairs, Redis rate limit |
| `/api/dashboard-data` | `N8N_WEBHOOK_DASHBOARD`, `DASHBOARD_AUTH_KEY` |
| `/api/roster` | `N8N_WEBHOOK_ROSTER`, `N8N_AUTH_KEY` |
| `/api/waitlist` | `N8N_WAITLIST_WEBHOOK`, `N8N_AGENCY_AUTH_KEY` |
| `/api/team-notes` | `N8N_WEBHOOK_GET_NOTES`, `N8N_WEBHOOK_POST_NOTE` |
| `/api/fill-gap`, `/api/bulk-sms`, … | Matching `N8N_WEBHOOK_*` + `N8N_AUTH_KEY` |

CORS on selected n8n webhook responses is scoped to `VERCEL_FRONTEND_URL`.

---

## 4. Security & Authentication Architecture

### 4.1 Frontend route guarding (JWT)

**Issuance**

- `POST /api/auth` verifies scrypt password hashes (`DOCTOR_*` / `ASSISTANT_*`).
- Signs **HS256 JWT** with `JWT_SECRET` (default TTL ≈ 8h; see `api/_lib/auth-crypto.js`).
- Login attempts are Redis rate-limited (e.g. 5 / 15 min window).

**Client storage**

- `sessionStorage`: `dentaflow_session` (JWT), `dentaflow_role`.
- Session is **tab-scoped** (cleared when the tab closes) — intentional for shared clinic machines.

**Guards (`auth.js`)**

| Mechanism | Behavior |
|-----------|----------|
| `enforceRouteGuard` / `requireSession` / `checkSession` | No valid JWT → hard teardown + login overlay |
| `assertAuthorizedResponse(response)` | HTTP **401** → `logout()` immediately |
| `registerLogoutTeardown` | Clears intervals/charts/init flags before redirect |
| `logout()` | Clears storage, runs teardowns, `location.replace(pathname + search)` |

**Anti-cascade rule:** On unauthorized API responses, the UI **must not** enter “Mode dégradé” empty-state paths. Treat 401 as session death, not as missing clinic data. `app.js` / `dashboard_app.js` call `assertAuthorizedResponse` (or equivalent) before interpreting payloads.

### 4.2 Backend concurrency (Redis memory locking)

```
acquire = SET lock:slot:<id> 1 NX EX <seconds>
if acquire != OK → abort concurrent mutation (another worker owns the slot)
```

Used across Concierge, waitlist, Twilio status dedup, and error monitor paths. Failures of Redis itself are treated as **hard errors** on critical paths (do not silently proceed without a lock when the workflow requires mutual exclusion).

### 4.3 Webhook & API authenticity

| Boundary | Control |
|----------|---------|
| Cal.com → n8n | HMAC-SHA256 webhook secret (`CAL_WEBHOOK_SECRET`), timing-safe compare |
| Twilio → n8n | `X-Twilio-Signature` vs Auth Token (`N8N_TWILIO_AUTH_TOKEN`) |
| Vercel → n8n | Shared secret header `x-agency-auth` / PIN; SHA-256 compare where `DASHBOARD_AUTH_KEY_SHA256` is configured |
| Browser → Vercel | Bearer JWT verified in each protected serverless handler |

### 4.4 Trust boundaries (summary)

```
Untrusted: Browser, Cal.com webhooks, Twilio webhooks, public lead forms
Semi-trusted: Vercel serverless (holds secrets; validates JWT)
Trusted automation: n8n (holds Baserow/Twilio/Cal/Slack credentials + Redis)
SSOT stores: Cal.com (calendar), Baserow/Postgres (records), Redis (ephemeral only)
```

---

## 5. Master Environment Variables Ledger

Values below are required or strongly recommended across **Development** (ngrok / test webhooks) and **Production** (Vercel + hosted n8n). Never commit real secrets. Prefer Vercel Project Settings and n8n **Variables** / host env.

### 5.1 n8n security overrides (host / Docker)

Code nodes call `require('crypto')` for HMAC and timing-safe compares. The n8n process **must** allow the built-in:

```bash
NODE_FUNCTION_ALLOW_BUILTIN=crypto
```

To expose selected host env vars into expressions / `$env` safely, configure an allowlist (exact variable names as deployed):

```bash
N8N_ENV_VARS_IN_ALLOWED_ENV=REDIS_CONNECTION_URL,REDIS_REST_TOKEN,BASEROW_API_TOKEN,BASEROW_API_URL,BASEROW_TABLE_ID,BASEROW_WAITLIST_TABLE_ID,BASEROW_WAITLIST_BROADCAST_TABLE_ID,BASEROW_LEADS_TABLE_ID,N8N_TWILIO_AUTH_TOKEN,N8N_WEBHOOK_BASE_URL,CAL_WEBHOOK_SECRET,CALCOM_API_KEY,CALCOM_EVENT_TYPE_ID,DASHBOARD_AUTH_KEY,DASHBOARD_AUTH_KEY_SHA256,VERCEL_FRONTEND_URL,CLINIC_ID,CLINIC_URGENCY_EMAIL,TWILIO_ACCOUNT_SID,TWILIO_FROM_NUMBER,WAITLIST_WORKFLOW_ID
```

> Adjust the allowlist to match whatever your n8n host actually injects. Prefer n8n **Variables** (`$vars`) for secrets when the deployment model supports them; keep `$vars['X'] ?? $env['X']` in Code nodes.

### 5.2 Vercel / frontend API (`Temara_Dashboard`)

#### Authentication

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | HS256 signing key for clinic JWTs (**≥ 32 random chars**) |
| `DOCTOR_USERNAME` | Doctor login identifier |
| `DOCTOR_PASSWORD_HASH` | `scrypt$…` hash from `api/_lib/auth-crypto.js` |
| `ASSISTANT_USERNAME` | Assistant login identifier |
| `ASSISTANT_PASSWORD_HASH` | `scrypt$…` hash |
| `DOCTOR_PIN` / `ASSISTANT_PIN` | Optional PIN paths if enabled in workflows |

Generate hashes:

```bash
cd Temara_Dashboard
node -e "const c=require('./api/_lib/auth-crypto');console.log(c.hashPassword('your-password'))"
```

#### n8n bridge secrets & webhooks

| Variable | Purpose |
|----------|---------|
| `N8N_AUTH_KEY` | Sent as `x-agency-auth` to n8n from most proxies |
| `N8N_AGENCY_AUTH_KEY` | Waitlist / agency-scoped auth (may equal `N8N_AUTH_KEY`) |
| `DASHBOARD_AUTH_KEY` | Dashboard KPI endpoint auth |
| `N8N_WEBHOOK_URL` | Legacy / generic dashboard webhook (dev ngrok) |
| `N8N_WEBHOOK_DASHBOARD` | Doctor KPI pull |
| `N8N_WEBHOOK_ROSTER` | Daily roster |
| `N8N_WEBHOOK_UPDATE_STATUS` | Status push |
| `N8N_WEBHOOK_DELAY_ALERT` | Delay alert |
| `N8N_WEBHOOK_FILL_GAP` | Fill-gap SMS trigger |
| `N8N_WEBHOOK_BULK_SMS` | Bulk SMS |
| `N8N_WEBHOOK_GET_NOTES` / `N8N_WEBHOOK_POST_NOTE` | Team notes |
| `N8N_WEBHOOK_LEAD_CAPTURE` | Patient portal leads |
| `N8N_WEBHOOK_ASSISTANT_PROXY` | Assistant generic proxy |
| `N8N_WAITLIST_WEBHOOK` | Waitlist intake |

#### Redis (login rate limit on Vercel)

| Variable | Purpose |
|----------|---------|
| `REDIS_CONNECTION_URL` | Upstash REST base URL |
| `REDIS_REST_TOKEN` | Bearer token for Upstash REST |

### 5.3 n8n runtime variables / env

#### Redis

```text
REDIS_CONNECTION_URL=https://<region>.upstash.io
REDIS_REST_TOKEN=<upstash-rest-token>
```

#### Baserow (relational / Postgres-backed SSOT for clinic records)

```text
BASEROW_API_URL=https://api.baserow.io
BASEROW_API_TOKEN=<token>
BASEROW_TABLE_ID=<primary-table>
BASEROW_WAITLIST_TABLE_ID=<waitlist>
BASEROW_WAITLIST_BROADCAST_TABLE_ID=<broadcast-log>   # or BASEROW_TABLE_ID where aliased
BASEROW_LEADS_TABLE_ID=<leads>
```

#### Cal.com

```text
CAL_WEBHOOK_SECRET=<hmac-secret>
CALCOM_API_KEY=<api-key>
CALCOM_EVENT_TYPE_ID=<numeric-id>
CLINIC_URGENCY_EMAIL=<clinic-urgency@domain>
```

#### Twilio / messaging

```text
N8N_TWILIO_AUTH_TOKEN=<auth-token>          # signature validation
N8N_WEBHOOK_BASE_URL=https://<n8n-host>     # exact public base used in signature URL
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_FROM_NUMBER=+212XXXXXXXXX            # or WhatsApp sender id as configured
```

Twilio credentials in n8n Credential store (“Twilio account”) must match these values. Meta WhatsApp sender IDs/tokens remain in Twilio/Meta consoles when the channel is WhatsApp.

#### Dashboard / CORS / clinic identity

```text
VERCEL_FRONTEND_URL=https://<your-vercel-app>.vercel.app
DASHBOARD_AUTH_KEY=<shared-secret>
DASHBOARD_AUTH_KEY_SHA256=<sha256-hex-of-key>   # when gate uses hashed compare
CLINIC_ID=<clinic-slug-or-id>
WAITLIST_WORKFLOW_ID=<n8n-workflow-id>          # if cross-workflow triggers used
N8N_AGENCY_AUTH_KEY=<shared-secret>
```

### 5.4 Optional / legacy aliases

| Variable | Notes |
|----------|-------|
| `N8N_WEBHOOK_URL` | Older single-webhook name; prefer explicit `N8N_WEBHOOK_*` in production |
| `KEY` | Avoid; use named secrets only |
| Direct `DATABASE_URL` / `POSTGRES_*` | Not wired in current dashboard/n8n Code paths; reserve for future direct Postgres access |

### 5.5 Environment matrix (checklist)

| Concern | Development | Production |
|---------|-------------|------------|
| Frontend host | Local static or Vercel Preview | Vercel Production |
| n8n reachability | ngrok / tunnel → `N8N_WEBHOOK_*` | Stable HTTPS n8n host |
| `VERCEL_FRONTEND_URL` | Preview URL(s) | Canonical prod URL |
| Cal.com / Twilio webhooks | Test event types / test numbers | Live secrets + signature gates on |
| Redis | Shared Upstash **dev** DB or separate prefix keys | Dedicated prod Upstash |
| JWT / passwords | Non-prod hashes | Unique `JWT_SECRET` + strong hashes |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` | `crypto` |

---

## Appendix A — Key repository paths

| Path | Role |
|------|------|
| `Temara_Dashboard/` | Production clinic UI + Vercel APIs |
| `Temara_Dashboard/auth.js` | Client JWT session, route guard, 401 logout |
| `Temara_Dashboard/api/_lib/auth-crypto.js` | scrypt, JWT, Redis login limiter |
| `Temara_Dashboard/.env.example` | Non-secret template for Vercel env |
| `n8n/` | Exported workflow JSON (import into n8n) |
| `n8n/_snippets/` | Shared Code-node snippets (Redis, auth gates) |

## Appendix B — Operational invariants

1. **Calendar SSOT = Cal.com.**  
2. **Patient/waitlist SSOT = Baserow (Postgres-backed).**  
3. **Redis = locks & rate limits only.**  
4. **401 = logout**, never degraded empty dashboard.  
5. **Webhook signatures on** before any write to Baserow or outbound SMS in production.  
6. **Secrets never in static JS** — only in Vercel env, n8n credentials/variables, and host env allowlists.

---

*End of document — DentaFlow OS System Architecture*
