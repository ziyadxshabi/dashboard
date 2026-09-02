# DentaFlow OS — Deployment & Verification Checklist

Clinique Dentaire Témara Mall. Timezone: **Africa/Casablanca**.

Use this document as the go/no-go gate before promoting a build to production. Tick every box. Do not skip a section because a previous one passed.

**How to use**

1. Copy this file into the release ticket (or print it) and date it.
2. Record the Vercel production URL, Git SHA, and operator name at the top of each run.
3. A section is complete only when every checkbox in it is ticked **and** evidence is attached (screenshot, curl output, Vercel log URL, or n8n execution ID).
4. If any item fails, stop. Do not proceed to the next section until it is green or an explicit waiver is written.

| Field | Value |
|---|---|
| Operator | |
| Date (Africa/Casablanca) | |
| Git SHA | |
| Production URL | `https://<your-vercel-domain>.vercel.app` |
| n8n host | |
| Result | ☐ GO / ☐ NO-GO |

---

# Pre-Deployment Verification Checklist

Complete this entire section **before** pushing to `main` or triggering a production deploy.

## 1. Vercel Environment Variables Audit

Source of truth: `Temara_Dashboard/.env.example` (28 variables). Set them in **Vercel → Project Settings → Environment Variables** for the **Production** environment (and Preview if you use preview URLs).

Do **not** commit a real `.env`. Do **not** paste secrets into this checklist.

### 1.1 Auth & session (5)

- [ ] `JWT_SECRET` — long random secret, unique per environment. Never reuse the development value in production.
- [ ] `DOCTOR_USERNAME` — production doctor login (plain username, not a secret hash).
- [ ] `DOCTOR_PASSWORD_HASH` — scrypt hash generated from `Temara_Dashboard`:
  ```bash
  node -e "const c=require('./api/_lib/auth-crypto');console.log(c.hashPassword('your-password'))"
  ```
- [ ] `ASSISTANT_USERNAME` — production assistant login.
- [ ] `ASSISTANT_PASSWORD_HASH` — scrypt hash generated the same way as the doctor hash.

### 1.2 Upstash Redis (2)

Required for login rate limiting across serverless instances. Cache is optional; locks and `ratelimit:login:<ip>` are not.

- [ ] `UPSTASH_REDIS_REST_URL` — Upstash REST URL (`https://….upstash.io`).
- [ ] `UPSTASH_REDIS_REST_TOKEN` — Upstash REST token. Confirm it is the **REST** token, not the Redis TCP password.

### 1.3 Baserow (5)

- [ ] `BASEROW_API_URL` — `https://api.baserow.io` (or self-hosted origin). No trailing slash required.
- [ ] `BASEROW_API_TOKEN` — database token with read/write on Agency Operations.
- [ ] `BASEROW_TABLE_ID` — Bookings table. Canonical ID: `1017856`.
- [ ] `BASEROW_WAITLIST_TABLE_ID` — Liste d'attente. Canonical ID: `1039940`.
- [ ] `BASEROW_LEADS_TABLE_ID` — lead table ID if lead capture writes to Baserow; leave documented if unused.

### 1.4 n8n webhook URLs (11)

Full HTTPS webhook URLs only. Frontend never calls these hosts. Empty values must fail closed (`503 Webhook not configured`), never fall back to a tunnel.

- [ ] `N8N_WEBHOOK_BASE_URL` — n8n origin used by `/api/health` (`GET {base}/healthz`).
- [ ] `N8N_WEBHOOK_DASHBOARD` — Dashboard Data Endpoint (`dashboard-data`).
- [ ] `N8N_WEBHOOK_DASHBOARD_ASSISTANT` — assistant proxy (`assistant-data`). Maps to `N8N_WEBHOOK_ASSISTANT_PROXY` in `/api/n8n`.
- [ ] `N8N_WEBHOOK_ROSTER` — roster / assistant-data webhook.
- [ ] `N8N_WEBHOOK_UPDATE_STATUS` — `update-status`.
- [ ] `N8N_WEBHOOK_WAITLIST` — waitlist add (legacy / cascade). Prefer Baserow for live waitlist reads.
- [ ] `N8N_WEBHOOK_FILL_GAP` — `fill-empty-slot`.
- [ ] `N8N_WEBHOOK_TEAM_NOTES` — documented in `.env.example`; also set `N8N_WEBHOOK_GET_NOTES` and `N8N_WEBHOOK_POST_NOTE` in Vercel if those names are what the functions read.
- [ ] `N8N_WEBHOOK_BULK_SMS` — `bulk-sms`.
- [ ] `N8N_WEBHOOK_DELAY_ALERT` — delay-alert webhook.
- [ ] `N8N_WEBHOOK_LEAD_CAPTURE` — `lead-capture`.

### 1.5 Agency auth keys (3)

Sent upstream as `x-agency-auth`. Server-only. Never expose to the browser.

- [ ] `N8N_AUTH_KEY`
- [ ] `N8N_AGENCY_AUTH_KEY`
- [ ] `DASHBOARD_AUTH_KEY` — preferred for `/api/dashboard-data`.

### 1.6 Application & deployment (2)

- [ ] `VERCEL_FRONTEND_URL` — production origin used as the allowed CORS origin (exact scheme + host, no trailing slash).
- [ ] `VERCEL_GIT_COMMIT_SHA` — usually injected by Vercel. Confirm `/api/health` `version` matches the deployed SHA prefix after ship.

### 1.7 Cross-checks

- [ ] All **28** names from `Temara_Dashboard/.env.example` exist in the Vercel Production environment (no typos, no Preview-only copies of production secrets).
- [ ] No `ngrok`, `ngrok-free.dev`, or tunnel host appears in any webhook URL.
- [ ] Redis vars are `UPSTASH_*` on Vercel (not `REDIS_CONNECTION_URL` / `REDIS_REST_TOKEN` — those belong to n8n `$vars`).
- [ ] Production `JWT_SECRET` is not the value used on Preview or a local `.env`.

---

## 2. n8n Workflow Synchronization

Import the sanitized JSON files from `/n8n` into the production n8n instance (self-hosted or n8n Cloud). Activate each workflow. Credentials must be n8n Credentials / `$vars` / `$env` — never hardcoded hosts or tokens inside nodes.

Exclude `n8n/skills-lock.json` (not a workflow).

### 2.1 Import & activate (19 workflows)

- [ ] `Dashboard Data Endpoint.json` — KPI payload for `/api/dashboard-data`. Bookings table `1017856`.
- [ ] `Workflow 1 - Load Dashboard (Pull).json`
- [ ] `Workflow 2 - Update Status (Push).json`
- [ ] `Workflow 2 - Update Patient Status (Two-Way Sync).json`
- [ ] `Workflow 3 - Team Notes Sync.json` — Tableau de Transmission `1039835` (`Auteur`, `Message`, `Heure`, `Épinglé`).
- [ ] `Workflow 4 - Waitlist Pipeline.json` — Liste d'attente `1039940`.
- [ ] `Workflow 5 - Bulk Confirm.json`
- [ ] `Dashboard - Bulk SMS Blast.json`
- [ ] `Dashboard - Bulk Cancel.json`
- [ ] `Lead Capture Engine.json`
- [ ] `Appointment Reminders Engine.json`
- [ ] `No-Show Waitlist Engine (1).json`
- [ ] `Production Concierge Engine v2.json`
- [ ] `Leak Protection Follow-up Engine.json`
- [ ] `Agency Master Error Monitor_v1.2.json`
- [ ] `Twilio Voice Menu v4.90 - Linear Pro.json`
- [ ] `Superpouvoir_Fill_Slot.json`
- [ ] `Superpouvoir_Block_Slot.json`
- [ ] `Superpouvoir_Force_SMS.json`

### 2.2 n8n runtime hygiene

- [ ] Every imported workflow is **Active** (toggle on). Inactive workflows make Vercel proxies time out or return 502.
- [ ] Webhook **path** segments match the Vercel env URLs (`dashboard-data`, `assistant-data`, `update-status`, `waitlist-add`, `get-notes`, `post-note`, `fill-empty-slot`, `bulk-sms`, `lead-capture`, delay-alert).
- [ ] n8n `$vars` / `$env` hold `REDIS_CONNECTION_URL` and `REDIS_REST_TOKEN` (do not copy Vercel `UPSTASH_*` names into n8n).
- [ ] Baserow nodes use table IDs `1017856` / `1039835` / `1039940` as data pointers, with `user_field_names = true`.
- [ ] Agency header expected from Vercel is `x-agency-auth` and matches `DASHBOARD_AUTH_KEY` / `N8N_AUTH_KEY`.
- [ ] Error Monitor workflow is active so failed executions surface (Slack or configured channel).

---

## 3. Twilio & Webhook Verification

Twilio must call the **production** domain (Vercel app or production n8n), never a developer tunnel.

- [ ] Twilio Console → Phone Number → Voice webhook URL uses the production n8n (or production Vercel) host. No `ngrok`, `ngrok-free.app`, or `ngrok-free.dev`.
- [ ] Twilio SMS / status callback URL uses the same production host.
- [ ] Twilio Voice Menu workflow (`Twilio Voice Menu v4.90 - Linear Pro.json`) inbound and status URLs were re-saved after import (n8n rewrite of webhook URLs).
- [ ] A test inbound SMS or voice event from Twilio hits the production workflow (confirm an n8n execution ID in the last 10 minutes).
- [ ] Production TLS is valid (no certificate warnings on the callback host).
- [ ] Frontend and Vercel proxies contain **no** `ngrok-skip-browser-warning` header and **no** hardcoded tunnel fallback.

---

# Deployment Execution

Do not deploy until Section 1–3 are complete.

## 4. Git branch verification

- [ ] `git status` is clean (no uncommitted clinic data, `.env`, or secrets).
- [ ] Feature work is merged to `main` (or the production branch configured in Vercel).
- [ ] `git log -1 --oneline` SHA is the candidate you will ship; record it in the table at the top of this file.
- [ ] `scripts/smoke-test.js` is present on the branch you are deploying.
- [ ] Last commits do **not** contain tokens, webhook URLs with secrets, or password hashes in plaintext files.

## 5. Vercel Git deployment

- [ ] Push (or Redeploy) Production from the merged SHA.
- [ ] Build log shows **zero** module-not-found / import errors for `Temara_Dashboard/api/*.js` and `_lib/*`.
- [ ] Functions appear under `/api/auth`, `/api/health`, `/api/roster`, `/api/waitlist`, `/api/dashboard-data`, `/api/update-status`, `/api/team-notes`, `/api/fill-gap`, `/api/bulk-sms`, `/api/lead-capture`, `/api/n8n-delay-alert` (or `/api/n8n?action=delay-alert` per `vercel.json`).
- [ ] Production alias / custom domain points at this deployment.
- [ ] `VERCEL_FRONTEND_URL` matches the URL users will open (scheme + host).
- [ ] After deploy, record the deployment URL and SHA in the header table.

---

# Post-Deployment Verification (Automated & Manual)

Replace `<your-vercel-domain>` with the real Production host. Do not test against Preview if you intend to sign off Production.

## 6. Automated smoke test run

Requires Node.js 18+ (native `fetch`). Use **production** doctor credentials, not the script fallbacks (`docteur` / `test-password`) unless this is a dedicated staging host.

```bash
node scripts/smoke-test.js https://<your-vercel-domain>.vercel.app
```

With explicit credentials:

```bash
TARGET_URL=https://<your-vercel-domain>.vercel.app ^
DOCTOR_USERNAME=<production-doctor-user> ^
DOCTOR_PASSWORD=<production-doctor-password> ^
node scripts/smoke-test.js
```

- [ ] Command executed against the **Production** URL.
- [ ] Test 1 — `GET /api/health` — PASS (HTTP 200 or 503 with `status` + `services`).
- [ ] Test 2 — `POST /api/dashboard-data` — PASS (HTTP 405, `METHOD_NOT_ALLOWED`).
- [ ] Test 3 — `GET /api/roster` without cookie — PASS (HTTP 401).
- [ ] Test 4 — `POST /api/update-status` invalid body — PASS (HTTP 400, `VALIDATION_ERROR`).
- [ ] Test 5 — `POST /api/lead-capture` short name — PASS (HTTP 400, `VALIDATION_ERROR`).
- [ ] Test 6 — `POST /api/auth` doctor — PASS (`role: doctor`, session cookie).
- [ ] Test 7 — `GET /api/roster` with session — PASS (HTTP 200).
- [ ] Test 8 — `GET /api/waitlist` with session — PASS (HTTP 200).
- [ ] Test 9 — `POST /api/auth/logout` — PASS (HTTP 200, cookie cleared).
- [ ] Summary line: Failed = 0. Process exit code **0**.

If any test fails, capture the script output, fix the API or env, redeploy, and re-run the full suite. Do not sign off a partial pass.

## 7. Health probe inspection

```bash
curl -sS https://<your-vercel-domain>.vercel.app/api/health
```

Expect HTTP **200** and:

```json
{
  "ok": true,
  "status": "healthy",
  "services": {
    "redis": { "status": "healthy" },
    "baserow": { "status": "healthy" },
    "n8n": { "status": "healthy" }
  }
}
```

- [ ] HTTP 200 (not 503 `degraded`).
- [ ] Top-level `status` is `"healthy"`.
- [ ] `services.redis.status` is `"healthy"` (not `unconfigured` or `down`).
- [ ] `services.baserow.status` is `"healthy"`.
- [ ] `services.n8n.status` is `"healthy"` (`N8N_WEBHOOK_BASE_URL` + `/healthz`).
- [ ] `version` matches the deployed Git SHA prefix (`VERCEL_GIT_COMMIT_SHA`).

HTTP 503 with `unconfigured` on Redis or n8n is a **NO-GO** for production even if the UI still loads (cache-optional paths can mask missing Redis until login brute-force protection is needed).

## 8. End-to-end role gate test

Use a real browser (not curl). Confirm both themes if you change `data-theme` during the session (`oak-lounge` / `pearl-clinic`). UI copy is French.

### 8.1 Doctor (`/` → Doctor Dashboard)

- [ ] Open Production `/`. Log in with doctor credentials. Session is an httpOnly cookie (`dentaflow_session`), not `localStorage` / `sessionStorage`.
- [ ] KPI cards render live values (`patients_today`, `no_shows`, `revenue_today`, `new_patients`, `accepted_plans`, `pending_plans` — not zeros from a swallowed 401).
- [ ] Appointments roster lists today’s Casablanca bookings (`Date & Heure du RDV`) with statuses `Confirmé` / `Annulé` / `No-Show` / `En attente` as applicable.
- [ ] Team notes (Tableau de Transmission) load; posting a note round-trips `Auteur`, `Message`, `Heure`, `Épinglé`.
- [ ] Log out. Cookie is cleared. Next `/api/*` call does not keep a doctor session.

### 8.2 Assistant (`/` → Assistant Dashboard)

- [ ] Log in with assistant credentials. Land on the assistant command center (`#assistant-shell` / `.assistant-app-root`).
- [ ] Waitlist loads from Baserow (or `/api/waitlist` 200 with rows / empty state — not a JS error).
- [ ] Add-patient (waitlist) modal submits `Nom`, `Priorité`, `Téléphone (WhatsApp)` and the new row appears (or a French success/error toast).
- [ ] Team notes push from the assistant shell appears for the doctor shell after refresh (same table `1039835`).
- [ ] Log out. Assistant cookie is cleared. Doctor routes are not accessible with the assistant session.

## 9. Offline / session expiry test

Goal: a missing or expired session **always** returns to the login screen. Never render empty KPIs or an empty roster as if the clinic had no patients.

- [ ] After login, delete `dentaflow_session` (and `dentaflow_session_ast` if present) in DevTools → Application → Cookies.
- [ ] Trigger a data refresh (reload, poll, or roster action). The app redirects to login; it does **not** paint zeroed KPI cards.
- [ ] Simulate HTTP 401 on `/api/roster` or `/api/dashboard-data` (expired JWT). Logout is immediate; no uncaught exception in the console.
- [ ] Login form remains usable (French labels, both themes, no broken layout).

---

# 24-Hour Post-Launch Monitoring

Start this clock at production cutover. Review at T+1h, T+6h, and T+24h.

## 10. Error tracking & health telemetry

- [ ] Poll `GET /api/health` at least hourly for 24 hours. `status` stays `"healthy"` for `redis`, `baserow`, and `n8n`.
- [ ] Vercel → Functions / Runtime Logs: no spike of 500/502/503 on `/api/auth`, `/api/roster`, `/api/dashboard-data`, `/api/waitlist`.
- [ ] n8n Executions: Dashboard Data Endpoint, Update Status, Team Notes, Waitlist, Lead Capture, and Twilio Voice show successful runs (or expected idle), not auth/HTML error pages.
- [ ] Agency Master Error Monitor fired only for real faults (dedup via Redis `errmon:dedup:*` if configured). No secret leakage in Slack/email bodies.

## 11. Upstash Redis rate limiter

Login window: key `ratelimit:login:<ip>`, max **5** attempts / **900s**.

- [ ] From a non-production IP (or a controlled test), submit **6** wrong passwords to `POST /api/auth`. The 6th response is HTTP **429**.
- [ ] Upstash Console shows `ratelimit:login:*` keys incrementing (TTL ~900s). Brute-force protection is therefore active across instances.
- [ ] Legitimate doctor/assistant logins still succeed from the clinic network after the test IP is limited (or wait for TTL).
- [ ] Optional cache keys (`dash:<role>:*`, `dashboard:kpi:payload`) may miss; that is acceptable. Missing Redis on **login rate limit** is not.

## 12. Sign-off

- [ ] Smoke test exit 0 on Production.
- [ ] `/api/health` is `healthy` for redis, baserow, and n8n.
- [ ] Doctor and assistant E2E gates passed.
- [ ] Session expiry returns to login without UI breakage.
- [ ] Twilio callbacks point at production, not ngrok.
- [ ] 24-hour monitoring owner is named and the T+24h review is scheduled.

**Production sign-off:** ☐ GO / ☐ NO-GO  
**Signed:** ______________________ **Date:** ______________
