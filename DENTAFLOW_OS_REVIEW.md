# DentaFlow OS — Engineering Review

**Date:** 4 September 2026  
**Scope:** Full repository as it exists today (not the docs, not the intended end-state).  
**Intent of this file:** Honest go / no-go notes for finishing a **sellable clinic operations product**, not a punch-list of lint nits.

---

## Verdict (read this first)

DentaFlow is a **working prototype of one clinic’s ops stack** (Clinique Dentaire Témara Mall), not yet a product you can sell to other dentists.

The vanilla frontend + Vercel `/api/*` + n8n + Baserow + Cal.com + Twilio design is coherent **for a single tenant**. The code has clearly been hardened in waves (httpOnly cookies, fail-closed webhooks, Baserow roster, scrypt, Redis rate limits). That work is real.

What is **not** real yet:

1. A deployable, documented production system with one source of truth.
2. A finished assistant/doctor product (two UIs, two auth models, missing patient portal).
3. A multi-clinic commercial architecture (everything is Temara-shaped).
4. Several bugs that will fail in the first week of live use (waitlist writes, assistant session restore, Sheets still in the write path).

**ENV_LEDGER.md is stale and must not be trusted.** It still describes ngrok fallbacks and JWT-in-sessionStorage. Those are gone from `Temara_Dashboard`. The ledger is now a liability: you will “fix” problems that no longer exist and miss the ones that do.

**Finish Temara first. Productize second.** Trying to do both at once is why this repo feels unfinished.

---

## What the repo actually is

```
Temara_Dashboard/              ← the real app (unified login + doctor shell + assistant-shell.html)
Temara_Dashboard/api/          ← the real Vercel API (JWT, Baserow, n8n proxies)
Temara_Assistant_Dashboard/    ← a second, older/parallel app (PIN login, weaker/no auth on roster)
Temara_Patient_Portal/         ← does not exist (0 files)
n8n/                           ← 19 workflows, several still writing Google Sheets
SYSTEM_ARCHITECTURE.md         ← partially true, partially a previous generation
ENV_LEDGER.md                  ← outdated (Aug 2026 audit of a previous tree)
DEPLOY_CHECKLIST.md            ← useful, more accurate than the architecture doc
public/index.html              ← stub (“Dev Runtime Active”), not a product
```

**Dashboard unification (your open question):**

| Surface | Status |
|---|---|
| Doctor + Assistant **login** on one page | Yes — `Temara_Dashboard/index.html` role toggle, username/password |
| Assistant **UI** after login | Yes — `auth.js` fetches `/assistant-shell.html` into `#assistant-mount` |
| `Temara_Assistant_Dashboard/` | Still a full second product: PIN keypad, own `api/auth.js` (PIN), own `api/roster.js` **with no JWT** |
| Patient booking UI | Missing. Lead API exists. Patients are expected to use Cal.com / a Google Sites URL hardcoded in n8n |

If you deploy **only** `Temara_Dashboard` as the Vercel root, the assistant folder is dead weight **unless someone points a second project at it**. If they do, they ship a PIN-gated app whose roster endpoint has no session check.

There is **no README**. `package.json` at repo root is leftover (`jsonwebtoken` unused; `"test": "echo \"Error: no test specified\""`). Real tests live as ad-hoc scripts (`scripts/smoke-test.js`, `api/_lib/auth-crypto.test.js`) and are not wired to `npm test`.

---

## 0. Product / architecture honesty (commercial)

You described DentaFlow as software **sold to private dental clinics**. The codebase is software **built for one named clinic**.

Hard Temara coupling (examples):

- UI copy, titles, Apple icon, login subtitle: “Clinique Dentaire Témara Mall”.
- Default assistant profile in `app.js`: `profileName: 'Sanae Amrani'`.
- Baserow table IDs hardcoded in n8n JSON (`1017856`, `1039940`, `1039835`) and in assistant roster (`TABLE_ID = '1017856'`).
- Waitlist SMS in n8n points patients to `https://sites.google.com/view/portail-temara-mall/accueil`.
- JWT payload is `{ role, sub }` only. No `clinicId`. Redis keys and n8n gates use `CLINIC_ID` with default `'temara'`.
- Cal.com, Twilio number, Slack, one Baserow database: all single-tenant.

**Engineering implication:** selling this as-is means cloning the whole stack per clinic (n8n instance or workflow copies, Baserow DB, Cal.com, Twilio, Vercel env). That is an agency delivery model, not a SaaS. Either own that (high-touch install, price accordingly) or you need a tenant model before the second customer.

**Operational implication of n8n as the engine:** every clinic becomes an n8n ops problem. Workflow JSON in git is not a deploy artifact. Exports contain `"active": true`, n8n `instanceId`, Baserow credential **names/ids**. Importing them onto a fresh n8n will not “just work”. There is no clinic onboarding script that creates tables, webhooks, and env.

**Stack opinion (not a rewrite demand):** for *one* clinic, n8n + Baserow + Cal.com is a fast way to ship automations. For a *product*, the current split is the main source of bugs: some paths hit Baserow from Vercel, some hit n8n, some still hit Sheets. Three write paths for one appointment status is how you get “the dashboard said Confirmé but Cal.com still shows booked and Sheets shows En attente”.

Recommended commercial sequencing:

1. Make **one Temara production** boringly reliable (auth, roster, status, waitlist, SMS, Cal.com sync).
2. Freeze the data contract (field names, statuses, who is SSOT).
3. Only then extract “clinic config” (name, table IDs, Cal.com event type, Twilio from, Vercel URL).
4. Do not sell EHR-adjacent features. The UI already shows **Observations Médicales** in the CRM panel. That is clinical content. If you are not an EHR, stop displaying and storing free-text medical notes in Baserow, or you inherit medical-data duties (access logs, retention, DPA with Baserow/n8n/Twilio) without the product value.

---

## 1. P0 — Will break live clinic operations

These are not theoretical. They are in the current code.

### 1.1 Waitlist POST writes the wrong Baserow columns

Canonical waitlist fields (project rules + n8n No-Show engine): `Nom`, `Priorité`, `Téléphone (WhatsApp)`.

`Temara_Dashboard/api/waitlist.js` `createWaitlistRow` sends:

```js
{ Patient: nom, Téléphone: telephone, Priorité: priorite }
```

n8n waitlist cascade then looks up `Nom` / `Téléphone (WhatsApp)`. Result: Vercel “add to waitlist” either **fails Baserow validation** or **inserts rows the SMS engine cannot see**. Gap-fill looks empty while the assistant thinks they added someone.

Also:

- Allowed priorities are `Haute | Normale | Basse`. Schema and UI talk about `Urgent`. Urgent is silently coerced to `Haute`.
- If `BASEROW_WAITLIST_TABLE_ID` is unset, the handler falls back to `BASEROW_TABLE_ID` (bookings). A misconfigured env writes waitlist people **into the appointments table**.
- POST does not invalidate the 20s GET cache. After a successful add, GET can still show the old list.
- `reason` / `notes` are sanitized then **dropped** — never written.

`n8n/Workflow 4 - Waitlist Pipeline.json` is also incomplete: Baserow “create” has `tableId: 1039940` and **no field mapping**. Even if you still used n8n for waitlist-add, that workflow would create empty/invalid rows.

### 1.2 Assistant session dies on refresh (unified dashboard)

`POST /api/auth` (Temara_Dashboard) always sets cookie `dentaflow_session`.

`GET/POST /api/auth/me` reads `expectedRole` from the body. Frontend sends `expectedRole` from `sessionStorage.dentaflow_role`.

`getTokenFromRequest(req, 'assistant')` **only** looks at `dentaflow_session_ast`. It does **not** fall back to `dentaflow_session`.

Sequence:

1. Assistant logs in on the unified page → cookie `dentaflow_session` is set.
2. Shell loads, work proceeds (API calls without `expectedRole` find the doctor cookie name and succeed).
3. Refresh → `/api/auth/me` with `expectedRole: "assistant"` → no `_ast` cookie → 401 → login overlay.

Doctor refresh works. Assistant refresh does not. This is a “we unified the UI but not the cookie model” bug. The second cookie name exists because `Temara_Assistant_Dashboard/api/auth.js` still issues `dentaflow_session_ast` for PIN login.

`auth.js` header even says `dentaflow_token`; the cookie is `dentaflow_session`. Small, but it shows the migration was never finished in one pass.

### 1.3 Appointment status is two different products glued together

Project rules / KPI mapping:

`Confirmé` | `En attente` | `Annulé` | `No-Show`

API `validation.js` + assistant UI `STATUS_OPTIONS`:

`Confirmé` | `En attente` | `En salle d'attente` | `En soin` | `Terminé` | `No-show` | `Annulé`

Problems:

- **`No-show` vs `No-Show`.** Baserow single-select is exact. UI/API normalize to `No-show`. Rules and Sheets formulas use `No-Show`. One of these will silently fail to match in KPIs or in n8n filters.
- Waiting-room states (`En salle d'attente`, `En soin`, `Terminé`) are a **real product feature** for chair-side flow. They are **not** in the documented Baserow select. If the Baserow field does not include them, every status PATCH from the assistant will 400/fail upstream.
- KPIs still count `Confirmé` / `En attente` / `No-Show`. A full waiting-room day can look like “zero accepted plans” if everyone is `En soin`.
- Update-status n8n workflow (`Workflow 2 - Update Patient Status`) still **mirrors into Google Sheets** (`documentId` `1UE-OacJhqgZJcLPJYRvHOnJzg4PXn256X9iKtNaXSJU`) **and** Baserow. Architecture says Sheets is not live KPI SSOT. This workflow says otherwise. Status can succeed in one store and fail in the other; the webhook still returns `success: true` after the last node that ran.

`update-status.js` sends `{ bookingId, newStatus }`. n8n looks up Baserow by a **numeric field id** filter on what is presumably Cal Booking ID. If the frontend sends Baserow row `id` in one place and Cal uid in another, updates hit the wrong row or none. `app.js` status `<select>` uses `data-booking-id="${record.calBookingId}"` — confirm that every roster row always has Cal Booking ID. No-shows created only in Baserow will not.

### 1.4 Google Sheets is still on the live write path

Despite `.cursorrules` and “Sheets is KPIs only / not used”:

| Workflow | Sheets? |
|---|---|
| Dashboard Data Endpoint | Baserow (good) |
| Workflow 1 - Load Dashboard (Pull) | **Reads Google Sheets Feuille 1** — duplicate of dashboard-data, still `"active": true` |
| Workflow 2 Two-Way Sync | **Writes Sheets + Baserow** |
| Workflow 2 Update Status (Push) | Deprecated path, still Sheets mirror, webhook path `deprecated-update-status-do-not-use` |
| Dashboard - Bulk Cancel | Parallel arrays “Baserow + Sheets key”, Sheets node present |
| Workflow 5 - Bulk Confirm | Sheets “Update to Confirmé” |
| Production Concierge Engine v2 | Multiple Sheets nodes + cached sheet URL |
| No-Show Waitlist Engine | Still has “Google Sheets - Add Patient” **and** Baserow find |
| Leak Protection Follow-up | Sheets URL cached |

This is the core architectural debt. You cannot reason about “where is the patient?” until **one** write path owns status and waitlist. Today a cancellation can update Baserow, fail Sheets, SMS a waitlist row that was only in Sheets, or the reverse.

`doctor.js` file header still documents Softr + published Google Sheets CSV. That is archaeology sitting on top of the real doctor dashboard. Anyone new (including you in three months) will implement the wrong backend.

### 1.5 `Temara_Assistant_Dashboard/api/roster.js` is unauthenticated

The production dashboard roster uses `requireBearerSession`.

The assistant-folder roster:

- Hardcodes `https://api.baserow.io` and table `1017856`.
- CORS `Access-Control-Allow-Origin: *`.
- **No JWT.** Anyone who can hit that deployment gets today’s appointments (names, phones, motifs).

This is only “safe” if that folder is never deployed. Git does not enforce that. A second Vercel project, a mistaken root directory, or a copy-paste of `api/` is a data leak.

PIN login in that folder is also weak: 4-digit PIN, `!==` compare (not timing-safe), **no Redis rate limit**, PIN stored in env as plaintext `DOCTOR_PIN` / `ASSISTANT_PIN`.

### 1.6 Patient portal is missing; public lead capture is a loaded gun

`Temara_Patient_Portal/` has no files. `doctor.js` comments that patient-portal code was removed. n8n still SMS-links a Google Site.

`/api/lead-capture` is **public** (no JWT), no rate limit, no captcha, no Redis. It forwards to n8n with `x-agency-auth`. If that webhook sends SMS or writes Baserow, this is an **SMS/cost and PII spam** endpoint on the open internet.

Fallback `N8N_WEBHOOK_LEAD_CAPTURE || N8N_WEBHOOK_BASE_URL` is dangerous: a missing specific webhook posts leads to the n8n **origin**, not the lead path.

### 1.7 Roster will time out as soon as the bookings table grows

`/api/roster` paginates **the entire Bookings table** (`size=200`) then filters “today” in Node, Africa/Casablanca. Timeout is 8s **per page**, but Vercel hobby/pro still has a function wall clock. A year of appointments is a 502 in the morning huddle.

Same pattern: n8n Dashboard Data Endpoint `returnAll: true` on table `1017856`.

There is no Baserow filter on date. This is the first scaling cliff, and it is not “lots of clinics” — it is **one busy clinic after 6–12 months**.

---

## 2. P1 — Security and session design (before a second human uses it)

### 2.1 What is actually good

- Passwords are scrypt hashes, not PIN-in-browser for the main app.
- JWT is httpOnly, `Secure`, `SameSite=Lax`, `Path=/`.
- Frontend does not put the JWT in `sessionStorage` anymore (role only).
- Proxies fail 503 if webhook/auth key missing (no ngrok fallback in current `Temara_Dashboard/api`).
- Timing-safe JWT compare; password compare uses `timingSafeEqual` when lengths match.
- Cal.com / Twilio HMAC snippets exist in Concierge and Voice Menu.
- `assertAuthorizedResponse` on 401 → logout (anti “empty clinic” trap) is the right idea.

### 2.2 Login rate limit fails open

`checkLoginRateLimit`: if Redis is down, `{ blocked: false, bypassed: true }`. Comment in architecture says cache may fail open; **login brute-force must not**. A Redis outage (or missing `UPSTASH_*` on a preview deploy) makes password guessing unlimited. `config.js` only *warns* on missing Redis.

INCR-then-EXPIRE is racy: two parallel first attempts can skip EXPIRE; a key can live without TTL.

`recordLoginFailure()` is a no-op. Failed logins still increment via INCR-on-every-attempt including successes until `resetLoginFailures`. That is OK, but the function name lies.

### 2.3 Cookie `Secure` without a local exception

`Secure` is always set. Local HTTP (`localhost` without TLS) **will not store the cookie**. You will debug “login returns 200 but I’m still on the overlay”. Use HTTPS locally or set `Secure` only when `x-forwarded-proto === https`.

### 2.4 JWT is homemade; `jsonwebtoken` in root `package.json` is unused

Claims: `role`, `sub`, `iat`, `exp`. No `iss`, `aud`, `jti`. `getClientFingerprint` exists and is **never bound** to the token. Stolen cookie works from any browser for 8 hours. Logout only clears the cookie; it does not revoke the JWT. For a clinic shared PC that is a real issue (front desk walks away).

8h TTL on a shared reception machine is long. Consider 8–12h with idle timeout, or shorter + refresh.

### 2.5 Client “session” is a role string

`isAuthenticated()` is `Boolean(sessionStorage.dentaflow_role)`. Anyone can set that key and pass `enforceRouteGuard` until the first `/api/*` 401. The overlay dismiss is tied to a successful login, but a crafted static open of the HTML still flashes shells. Not a remote exploit if APIs are locked; still a messy trust boundary.

### 2.6 `/api/n8n.js` lies with HTTP 200

`respondUpstreamFailure` returns **status 200** + `{ ok: false }`. Delay-alert does the same. Frontends that only check `response.ok` will treat n8n downtime as success. Dashboard-data and update-status correctly use 502. Inconsistent contract.

`handleProxy` (`/api/n8n-proxy`) is `allowedRoles: ['doctor']` while comments say “assistant/KPI proxy”. Assistants calling it get 403. Env name in `.env.example` is `N8N_WEBHOOK_DASHBOARD_ASSISTANT`; the handler reads **only** `N8N_WEBHOOK_ASSISTANT_PROXY`. `config.js` aliases both; **no handler imports `config.js`**. The whole config module is dead code.

### 2.7 CSP is theatre

`vercel.json`:

```
connect-src 'self' https: wss:
script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com
```

Any HTTPS endpoint is connectable from the browser. Combined with `lucide@latest` (floating major version) you have a supply-chain surface. Pin versions. Tighten `connect-src` to `'self'` only — the whole point of `/api/*` proxies.

`X-Frame-Options: DENY` is good. HSTS preload on a project with **no production domain yet** is premature (you can HSTS a preview URL you later abandon).

### 2.8 `/api/health` is public and talkative

Unauthenticated. Returns Redis/Baserow/n8n status and commit SHA. Useful for you; also useful for recon. Gate it or reduce to `{ ok: true/false }`.

`applyCors`: if `VERCEL_FRONTEND_URL` is unset, **no** `Access-Control-Allow-Origin`. Same-origin Vercel is fine. Opening the HTML from another origin (assistant subdomain, patient domain) will fail credentialed fetches.

### 2.9 Bulk SMS / fill-gap / generic proxy

- Bulk SMS: if the client omits recipients entirely, the body is still forwarded (`customMessage` only). Whatever n8n does with an empty recipient list is the blast radius. Confirm the workflow **refuses** empty lists.
- Generic `/api/proxy` streams **upstream status, body, Content-Disposition** to the browser. Fine for CSV export; also a way to exfiltrate n8n error HTML if a target URL is wrong.
- `x-agency-auth` is a static shared secret. n8n still accepts `body.pin` as alternate credential (`auth_dashboard.js`). A leaked PIN in an old client would still authenticate automation.

### 2.10 PII and medical-adjacent data

Roster JSON is the full Baserow row (email, WhatsApp, insurance number, observations). Cached in Redis 30s under `roster:{role}:default`. Redis is “ephemeral” but it is still a copy of the day’s PHI-adjacent data at Upstash. Treat Upstash as in-scope for a DPA.

`sanitizeString` strips `<>&"'`. French names (`L’Hôpital`, `N’Diaye`) and observations lose apostrophes. That is data corruption, not security.

### 2.11 Settings “change password” is not server-backed

Doctor settings purge legacy localStorage password keys (good — ENV_LEDGER’s “password in localStorage” is **fixed**). Ephemeral passwords live in RAM only. There is **no** API to rotate `DOCTOR_PASSWORD_HASH`. The UI can pretend to change a password and nothing in Vercel env changes. Do not demo that screen to a buyer.

---

## 3. P1 — Split brain: Vercel vs n8n vs Baserow vs Cal.com

Intended SSOT (architecture doc):

| Fact | Owner |
|---|---|
| Calendar slot | Cal.com |
| Patient / waitlist row | Baserow |
| Locks | Redis |
| KPIs | (doc says Sheets; code’s Dashboard Data Endpoint says Baserow) |

Actual:

- Roster **read**: Vercel → Baserow (n8n roster webhook unused).
- Waitlist **read/write**: Vercel → Baserow (n8n waitlist webhook unused) with **wrong fields**.
- KPIs **read**: Vercel → n8n → Baserow (and a second active workflow still on Sheets).
- Status **write**: Vercel → n8n → Baserow **and** Sheets.
- Booking **create**: Cal.com → n8n Concierge → Baserow (+ Sheets remnants).
- Notes: Vercel → n8n → Baserow table `1039835`.
- Fill-gap / bulk SMS: Vercel → n8n → Twilio.

So the “proxy pattern” in the Cursor rules is only true for some routes. Roster/waitlist are a **second backend** inside Vercel. That is not wrong (fewer hops, good), but then:

- n8n waitlist/roster workflows and env vars are leftover surface area.
- Field-name bugs are now in Node, not in n8n, and they **diverged**.
- Concierge “slot filled cleanup” uses `BASEROW_TABLE_ID` as broadcast table id in one snippet (`BROADCAST_TABLE_ID = $vars['BASEROW_TABLE_ID']`). That can point cleanup at **bookings** instead of the broadcast log.

Cal.com is SSOT for *slots*, Baserow for *ops state*. Nothing in `/api/update-status` updates Cal.com. Marking `Annulé` in the dashboard can leave the calendar slot booked unless a separate n8n path cancels Cal. Double-booking and “ghost occupied” slots are the failure mode. Confirm Concierge cancel and dashboard cancel are the same path.

Redis locking: architecture says fail **closed** on lock paths. Vercel Redis helper fails **open** (cache miss). n8n lock helpers return `{ acquired: false }` on Redis error in some snippets and throw in others. Inconsistent. For fill-gap/cascade, fail closed or you SMS two patients for one chair.

---

## 4. Frontend: one app, two copies, 5k-line files

### 4.1 Unified shell (Temara_Dashboard) — mostly the right shape

- Role-gated doctor vs assistant after login.
- `credentials: 'include'` on fetches.
- Doctor queries scoped via `doctorShell()`; assistant via `assistantRoot()` pattern in rules.
- French UI, two themes in CSS (login page **forces** `oak-lounge` in a head script, so pearl-clinic preference can fight the first paint).
- `user-scalable=no` + `maximum-scale=1.0`: bad for accessibility and WCAG; clinic staff with presbyopia will hate it.

CDN: Chart.js, GSAP, FullCalendar, Lenis, Lucide. Fine for a prototype. For a product, vendor them or pin hashes. FullCalendar + GSAP + Chart.js on the login page is a lot of JS before auth.

`app.js` (~5.5k lines) and `doctor.js` (~3.7k) are unmaintainable. Duplicate pulse cards, roster renderers, settings, waitlist, notes exist in **both** `Temara_Dashboard/app.js` and `Temara_Assistant_Dashboard/app.js`. They have already drifted (pulse HTML, innerHTML vs createElement). **Delete or archive `Temara_Assistant_Dashboard` once the unified shell is the only deploy**, or you will fix bugs twice and miss one.

`assistant-shell.html` is injected with `template.innerHTML = html`. That is your own static file — OK. Do not ever inject n8n HTML that way.

Some `innerHTML` paths use `escapeHtml`; others interpolate counts only. Assistant-folder notes still concatenate `innerHTML` with escaped fields in some branches — keep auditing any `innerHTML` that includes `record.name`.

### 4.2 Fake settings / localStorage

`dentaflow_assistant_prefs`: theme, display name, SMS/email reminder **toggles**. Those toggles do not obviously call an API to disable Twilio reminders. Staff will turn “SMS reminders” off in the UI and patients will still get n8n Appointment Reminders Engine messages.

### 4.3 Error copy still mentions the old world

`app.js` `formatRosterErrorMessage` tells the user to activate **« Workflow 1 - Load Dashboard »**. Roster no longer uses that webhook. Operators will activate the wrong workflow.

Cancel path mentions Google Sheets sync failure (`Annulation Partielle : ... Google Sheets a échoué`). If you have not dropped Sheets, that message is true and terrifying. If you have, it is a lie.

---

## 5. n8n: too many workflows, overlapping jobs

DEPLOY_CHECKLIST lists **19** workflows to activate. Several pairs do the same job:

| Pair | Conflict |
|---|---|
| Dashboard Data Endpoint vs Workflow 1 Load Dashboard | Two KPI/roster pulls, Baserow vs Sheets |
| Workflow 2 Two-Way Sync vs Workflow 2 Update Status (Push) | Two status webhooks; one marked deprecated in path only |
| Workflow 4 Waitlist vs No-Show Waitlist Engine vs Vercel `/api/waitlist` | Three add/cascade stories |
| Superpouvoir Fill/Block/Force SMS | Power-user paths not visible as first-class product features |

Webhook path names must match Vercel env **exactly**. There is no test that imports JSON and asserts path `update-status` === `N8N_WEBHOOK_UPDATE_STATUS` suffix.

n8n JSON contains:

- Google Sheet IDs (client spreadsheet — treat as sensitive).
- Credential ids (`Baserow account 2`, `Google Sheets account 2`).
- n8n `instanceId`.
- `"active": true` which can turn workflows on at import in some n8n versions.

`NODE_FUNCTION_ALLOW_BUILTIN=crypto` is a real production footgun: if forgotten, HMAC gates throw and webhooks 500, or worse, someone “temporarily” disables the gate.

Auth gates fail open on Redis in Dashboard Data Endpoint (`redis_outage_bypassed`). Combined with Vercel JWT, n8n is still reachable if someone learns the agency key.

---

## 6. Docs vs code (do not ship on the wrong map)

| Document says | Code does |
|---|---|
| JWT in sessionStorage | Cookie `dentaflow_session`; role in sessionStorage |
| Google Sheets = KPI SSOT | Dashboard Data Endpoint uses Baserow; Sheets still written elsewhere |
| `dashboard_app.js` | Split into `doctor.js` + `shared.js` + `app.js` |
| Patient portal folder | Empty |
| ENV_LEDGER: ngrok fallbacks in api/*.js | **Removed** from Temara_Dashboard API |
| ENV_LEDGER: frontend `API_BASE` ngrok | **Removed**; `/api/*` only |
| `.env.example` `N8N_WEBHOOK_TEAM_NOTES` | `team-notes.js` wants `GET_NOTES` + `POST_NOTE` |
| `.env.example` `N8N_WEBHOOK_DASHBOARD_ASSISTANT` | `n8n.js` wants `N8N_WEBHOOK_ASSISTANT_PROXY` |
| `config.js` centralizes env | **Zero** `require('./_lib/config')` from handlers |
| Architecture: Redis fail closed on locks | Vercel cache fail open; n8n mixed |
| Status enum in rules | UI has waiting-room states + `No-show` spelling |

`DEPLOY_CHECKLIST.md` is the closest thing to a production brain. Use it; rewrite SYSTEM_ARCHITECTURE and burn ENV_LEDGER after one new audit.

---

## 7. What is *not* wrong (so you don’t waste a week)

- Vanilla JS / no bundler: a constraint, not a bug, **for one clinic**. It becomes a bug when you hire a second developer or want tests around modules.
- httpOnly cookie direction: correct. Finish the assistant cookie name, don’t revert to sessionStorage JWT.
- Failing closed when n8n URL is missing: correct (current Temara_Dashboard handlers).
- Casablanca timezone on roster filter: correct idea; implementation is “scan everything”.
- Role split doctor vs assistant on API (`dashboard-data` doctor-only, `fill-gap` assistant-only): sensible.
- `escapeHtml` / createElement in the newer assistant notes path: right instinct.
- Auth-crypto unit tests: small but they exist. Run them in CI.
- No ngrok strings in current JS/JSON grep of the repo: the Phase 2 cleanup in ENV_LEDGER **did happen** in code. The ledger wasn’t updated.

---

## 8. Suggested finish order (realistic)

Do not start a rewrite. Sequence:

### Slice A — Make Temara internally consistent (1–2 weeks of focused work)

1. **Pick SSOT for status**  
   Cal.com owns the slot. Baserow owns ops status. **Delete Sheets from write workflows** or you will never know what is true. Deactivate Workflow 1 (Sheets pull) so it cannot fight Dashboard Data Endpoint.
2. **Fix waitlist field names** to `Nom` / `Téléphone (WhatsApp)` / `Priorité`; stop falling back to bookings table; bust cache on POST; add `Urgent` or stop showing it in the UI.
3. **Fix assistant cookie**: either set `dentaflow_session_ast` on assistant login, or stop passing `expectedRole` into `getTokenFromRequest` so one cookie works. Delete PIN auth or isolate it so it cannot be deployed.
4. **One status enum** in Baserow, validation.js, app.js, doctor.js, KPI code, n8n. Decide waiting-room states now; add them to Baserow or remove them from the UI.
5. **Confirm update-status key**: always Baserow row id or always Cal uid, never both by accident. Align n8n lookup.
6. **Archive `Temara_Assistant_Dashboard`** (move to `/_attic`) so it cannot be deployed with an open roster.
7. **Rewrite SYSTEM_ARCHITECTURE + ENV_LEDGER** to match the tree, or delete them.

### Slice B — Production hygiene

8. Wire `config.js` into every handler or delete it.
9. Align `.env.example` names with actual `process.env` reads (`GET_NOTES`, `POST_NOTE`, `ASSISTANT_PROXY`).
10. Rate-limit login **fail closed** if Redis missing in production (`503` not “allow”).
11. Rate-limit `/api/lead-capture`. Do not ship it public without a portal + captcha.
12. Pin CDN versions; CSP `connect-src 'self'`.
13. Baserow date filter for roster/KPIs (or a “today” view). 8s full-table scan will fail.
14. `npm test` runs `auth-crypto.test.js` + `scripts/test-handlers-direct.js`.
15. One Vercel project root: `Temara_Dashboard`. Root `public/index.html` stub should not be the production `/`.

### Slice C — Only after Temara has run for 30 days

16. Patient entry: Cal.com embed on a page you control, or a thin portal that does **not** invent a second calendar.
17. Tenant config object (clinic name, table IDs, from-number, Cal event type, logo). No second clinic until this exists.
18. Drop medical free-text from the ops UI if you want to stay outside EHR regulation.
19. Then talk about selling.

---

## 9. Open opinions (engineering)

**n8n is the wrong long-term application server.** It is excellent for Twilio/Cal.com glue. It is a poor place to keep canonical status updates, field mappings, and auth. Every “Workflow 2” duplicate is proof. Move remaining **synchronous** CRUD (status, notes, waitlist) fully into Vercel+Baserow (like roster already is), and keep n8n for **async** side effects (SMS, Slack, Cal.com webhooks, reminders). Right now you are halfway through that migration, which is the most dangerous place.

**Baserow is the wrong long-term product database.** Fine for an MVP. You already scrape `returnAll` and paginate in a loop. The moment you need transactions (cancel slot + notify waitlist + write broadcast log), you will feel the lack of a real DB. Plan a Postgres (even Baserow’s underlying Postgres via a proper API) before clinic #3, not after a corruption incident.

**Cal.com as calendar SSOT is the right call.** Do not replace it with FullCalendar as a writer. FullCalendar on the dashboard should be a view, not a second booking engine. Verify that it is display-only.

**Two themes and GSAP on a reception iPad** are not why this won’t sell. Unreliable waitlist and dual Sheets/Baserow are. Spend design time after the data plane is boring.

**Security is “better than a Softr page”, not “ready for 50 clinics’ patient phones”.** Shared front-desk login, 8h JWT, fail-open rate limit, public lead webhook, unauthenticated health, and an unauthenticated roster in a sibling folder are the actual risk register.

**You do not have a documentation problem.** You have **three generations of the system in one git tree** (Softr/Sheets comments, PIN assistant app, cookie+Baserow dashboard) and docs that describe generation 1.5. Finishing means deleting, not adding.

---

## 10. File-level watchlist (quick)

| File | Issue |
|---|---|
| `Temara_Dashboard/api/waitlist.js` | Wrong field names; table fallback; no cache bust |
| `Temara_Dashboard/api/auth.js` + `_lib/auth-crypto.js` | Assistant `expectedRole` vs cookie name |
| `Temara_Dashboard/auth.js` | Role-only “session”; comment mismatch |
| `Temara_Dashboard/api/_lib/validation.js` | Status enum ≠ Baserow rules |
| `Temara_Dashboard/api/n8n.js` | 200 on failure; env name; doctor-only proxy |
| `Temara_Dashboard/api/_lib/config.js` | Unused |
| `Temara_Dashboard/api/lead-capture.js` | Public, no rate limit, bad fallback URL |
| `Temara_Dashboard/api/roster.js` | Full table scan |
| `Temara_Assistant_Dashboard/api/roster.js` | No auth |
| `Temara_Assistant_Dashboard/api/auth.js` | 4-digit PIN, no rate limit |
| `n8n/Workflow 2 - Update Patient Status*.json` | Sheets + Baserow dual write |
| `n8n/Workflow 1 - Load Dashboard (Pull).json` | Sheets, still active |
| `n8n/Workflow 4 - Waitlist Pipeline.json` | Create node without fields |
| `n8n/No-Show Waitlist Engine (1).json` | Sheets add + Google Sites URL |
| `ENV_LEDGER.md` | Stale; ignore as SSOT |
| `SYSTEM_ARCHITECTURE.md` | SessionStorage/Sheets/dashboard_app lies |
| `Temara_Dashboard/doctor.js` | Softr/Sheets header; live KPI code underneath |
| `Temara_Patient_Portal/` | Missing |
| `public/index.html` | Not the product |
| `package.json` | Dead deps; no real test script |

---

## Bottom line

You are closer than ENV_LEDGER makes it sound on **secrets-in-frontend** and **ngrok**. You are further than SYSTEM_ARCHITECTURE makes it sound on **SSOT**, **waitlist**, **assistant auth**, and **productization**.

Treat this as a **single-clinic production hardening** project for the next stretch. The commercial story (sell to any dentist) starts after Temara can run a full day without Sheets, without a refresh-logout for the assistant, and without a waitlist that writes into the void.
