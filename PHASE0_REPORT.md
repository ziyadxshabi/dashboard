# Phase 0 report — act catalog (chunk 1)

Owner-facing record of Phase 0 work through live verification of the doctor Réglages **Tarifs cabinet** card. French UI copy is left in French. Chunks 2 and 3 are not started.

Live proof target: preview deployment `dpl_3P1b6KbA8Fe7bs582cQBntG5Azbt` (`affdf91`) at `https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app`. Production alias `https://dashboard-shabi1.vercel.app` is still `main` and does not include this card.

---

## 1. Scope recap

- **Chunk 1 — Act catalog:** done and verified live. 107 NGAP rows in `act_reference`, 16 placeholder prices on slug `temara`, `GET /api/acts` + `PUT /api/acts/price` through roster, doctor Tarifs cabinet card populated on the live preview.
- **Chunk 2 — Insurance profile v2:** pending. No patient columns, PATCH/GET/export wiring, or carnet sheet fields yet.
- **Chunk 3 — Payments:** pending. No `payments` table, no GET/POST roster actions, no Règlements block, no `PATIENT_SHARE` TODO comment.

---

## 2. Database changes

**Supabase project:** `dentaflow-dev` (`kiplbaajxvhiehjgzmor`). This is the database Vercel `DATABASE_URL` on `dashboard-shabi1` uses.

**Migration:** `supabase/migrations/20260919_phase0_foundations.sql`  
Applied on prod as version `20260919141953` / name `phase0_foundations`.

**Seed:** `supabase/seeds/act_reference_seed.sql` (107 verbatim NGAP `INSERT … ON CONFLICT DO NOTHING` rows). Not inlined in the migration.

**Mirrors:** same tables in `supabase/schema.sql` (UUID `clinic_id` + RLS) and `scripts/dev-schema.sql` (`clinic_id TEXT`, no RLS — local-dev convention).

### Job A before / after (prod)

| Check | Before (live empty-card diagnosis) | After |
| --- | --- | --- |
| `to_regclass('public.act_reference')` | `NULL` (table missing) | `act_reference` |
| `to_regclass('public.clinic_act_prices')` | `NULL` (table missing) | `clinic_act_prices` |
| `SELECT count(*) FROM act_reference` | n/a | **107** |
| `SELECT count(*) FROM clinic_act_prices` | n/a | **16** (12 NGAP + 4 custom) |
| `SELECT id, slug FROM clinics` | `4abc388e-18d4-4abe-8dcd-c529d6407e4f` / `temara` | unchanged |

Root cause of the live empty card: code shipped, catalog tables did not exist on prod. Local tests had applied SQL to the agent Postgres, not to this database. Slug was already exactly `temara`; the placeholder insert did not need a different slug. After the NGAP seed, the placeholder `INSERT` was re-run so the 12 NGAP prices could satisfy the FK.

### Tables and columns created

**`act_reference`** (global tenancy exception — shared nomenclature, no `clinic_id`)

| Column | Type | Notes |
| --- | --- | --- |
| `code` | `TEXT` PK | NGAP code (`D700`, …) |
| `label` | `TEXT NOT NULL` | French label |
| `category` | `TEXT NOT NULL` | `soins` \| `chirurgie` \| `prothese` \| `orthodontie` \| `parodontologie` |
| `coefficient` | `NUMERIC NULL` | |
| `letter_key` | `TEXT NOT NULL DEFAULT 'soins'` | `soins` \| `prothese` |
| `tnr_mad` | `NUMERIC(12,2) NULL` | ANAM TNR |
| `requires_prior_approval` | `BOOLEAN NOT NULL DEFAULT false` | |
| `active` | `BOOLEAN NOT NULL DEFAULT true` | deactivate, never delete |

**`clinic_act_prices`** (clinic-scoped)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `UUID` PK | `gen_random_uuid()` |
| `clinic_id` | `UUID NOT NULL` | FK `clinics(id) ON DELETE CASCADE` |
| `act_code` | `TEXT` | FK `act_reference(code)`, null for custom |
| `custom_label` | `TEXT` | required when `act_code` is null |
| `price_mad` | `NUMERIC(12,2) NOT NULL` | `>= 0` |
| `active` | `BOOLEAN NOT NULL DEFAULT true` | deactivate, never DELETE |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Constraints / indexes:

- `CHECK (act_code IS NOT NULL OR NULLIF(custom_label, '') IS NOT NULL)`
- Partial unique `idx_clinic_act_prices_clinic_act` on `(clinic_id, act_code) WHERE act_code IS NOT NULL`
- `idx_clinic_act_prices_clinic` on `(clinic_id, created_at DESC)`
- Custom rows (`act_code IS NULL`) are **not** covered by the unique index; seed/migration use `NOT EXISTS` + `IS NOT DISTINCT FROM`

RLS (prod + `schema.sql`; skipped on local Docker if `anon`/`authenticated` roles are absent):

- `ENABLE ROW LEVEL SECURITY` on both tables
- Policy `deny_client_roles` `FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)`
- `REVOKE ALL` on both tables from `anon`, `authenticated`
- Staff access is the Node `postgres` pool (`BYPASSRLS`), same pattern as the Data API lockdown

### Placeholder prices (`clinics.slug = 'temara'` only)

| Act | Kind | `price_mad` |
| --- | --- | ---: |
| D708 Détartrage complet sus et sous-gingival — par séance (max 2) | NGAP | 400 |
| D700 Obturation — cavité simple, traitement global | NGAP | 400 |
| D701 Obturation — cavité composée 2 faces | NGAP | 500 |
| D702 Obturation — cavité composée 3 faces et plus | NGAP | 600 |
| D704 Dévitalisation — groupe incisivo-canin | NGAP | 800 |
| D705 Dévitalisation — groupe prémolaires | NGAP | 1000 |
| D706 Dévitalisation — groupe molaires | NGAP | 1200 |
| D713 | NGAP | 400 |
| D720 | NGAP | 1500 |
| D754 | NGAP | 2500 |
| D758 | NGAP | 1000 |
| D773 Prothèse adjointe totale — maxillaire supérieur | NGAP | 6000 |
| Consultation | custom | 250 |
| Blanchiment | custom | 3000 |
| Implant + couronne | custom | 8000 |
| Couronne zircone | custom | 4000 |

Prod confirmation after Job A: those 16 rows exist; Consultation was live-edited 250 → 260 (persisted after reload) then restored to 250.

---

## 3. API changes

Hobby stays at 12/12. No new file under `Temara_Dashboard/api/`. Both endpoints multiplex on `Temara_Dashboard/api/roster.js` and run in `Temara_Dashboard/api/_lib/roi-ops.js`. Pretty aliases in `Temara_Dashboard/vercel.json`, `Temara_Dashboard/public/vercel.json`, and root `vercel.json`.

Shared error envelope: `{ ok: false, error: string, code: string }`.

### `GET /api/acts`

| | |
| --- | --- |
| Alias | `GET /api/acts` |
| Underlying | `GET /api/roster?action=acts` |
| Handler | `roiOps.handleActsGet` |
| Roles | `doctor`, `assistant` (session cookie `dentaflow_session`) |
| Body | none |
| Query | one SQL: `act_reference` `LEFT JOIN clinic_act_prices` for the session `clinic_id`, `UNION ALL` custom rows (`act_code IS NULL`), skip `active = false` reference rows |

**200 response**

```json
{
  "ok": true,
  "data": {
    "reference": [ { "code", "label", "category", "coefficient", "letter_key", "tnrMad", "requiresPriorApproval", "priceMad", "priceId", "insurable", "active" } ],
    "custom": [ { "code": null, "label", "priceMad", "priceId", "insurable": false, "active" } ]
  }
}
```

`insurable` is `true` only for reference rows with a code (`act_code IS NOT NULL`). Custom acts are price-only and must not appear on future insurance paperwork.

**Errors**

| Status | Code | When |
| ---: | --- | --- |
| 401 | `UNAUTHORIZED` | missing / invalid session |
| 403 | `FORBIDDEN` | authenticated role outside `doctor`/`assistant` (not used for these two roles) |
| 405 | `METHOD_NOT_ALLOWED` | non-GET on the roster GET branch (PUT is a separate branch) |
| 500 | `SERVER_ERROR` | database error |
| 503 | `SERVER_ERROR` | `DB_NOT_CONFIGURED` |

Live (this preview, doctor cookie): **HTTP 200**, `ok: true`, `reference.length = 107`, `custom.length = 4`, 12 priced NGAP rows. Anon (SSO bypass cookie only, no app session): **HTTP 401** `UNAUTHORIZED`.

### `PUT /api/acts/price`

| | |
| --- | --- |
| Alias | `PUT /api/acts/price` |
| Underlying | `PUT /api/roster?action=act-price` |
| Handler | `roiOps.handleActPricePut` |
| Roles | **`doctor` only** (assistant → 403) |
| Body | `{ "act_code"?: string, "custom_label"?: string, "price_mad": number, "active"?: boolean }` (`actCode` / `customLabel` / `priceMad` aliases accepted) |

Validation (`validateActPriceBody`): `price_mad` must be a finite number `>= 0`; at least one of `act_code` or `custom_label`; `active` defaults to `true` when omitted.

Behavior:

- `act_code` set: must exist on `act_reference` (`active = true`) or **400** `Unknown act_code`. Upsert on partial unique `(clinic_id, act_code)`.
- `act_code` omitted + `custom_label`: `UPDATE` matching clinic custom row, else `INSERT`. No DELETE.
- `active: false` deactivates the price row.

**200 response:** `{ ok: true, data: <mapped act row> }` (`priceMad`, `code`/`label`, `insurable`, `active`, `priceId`).

**Errors**

| Status | Code | When |
| ---: | --- | --- |
| 401 | `UNAUTHORIZED` | no session |
| 403 | `FORBIDDEN` | assistant (or any non-doctor) |
| 400 | `VALIDATION_ERROR` | bad/missing `price_mad`; missing `act_code` and `custom_label`; unknown `act_code` |
| 500 / 503 | `SERVER_ERROR` | database |

UI calls `GET ${CONFIG.ROSTER_PROXY}?action=acts` and `PUT ${CONFIG.ROSTER_PROXY}?action=act-price` (query-string form). Aliases exist for curl / external clients.

---

## 4. UI changes

Vanilla doctor SPA. Assistant has no editor (`assistant-shell.html` has no `#settings-tarifs-list`).

| File | User-visible change |
| --- | --- |
| `Temara_Dashboard/index.html` (+ public mirror) | Réglages card **Tarifs cabinet**: count line, scrollable list, empty copy **Aucun acte tarifé.**, error block **Tarifs indisponibles — réessayer** + **Réessayer** button. Icon `circle-dollar-sign`. |
| `Temara_Dashboard/dashboard_app.js` (+ public mirror) | `switchTab` / settings hash loads GET acts (not on boot). Renders `[...custom, ...reference]` so all 107 NGAP rows appear, priced or not. Save on `change` and `blur`. GET `!ok` or `payload.ok === false` → error UI + `console.error('[Settings] acts GET failed', { status })`. Retry rebinds in `initSettings`. |
| `Temara_Dashboard/dashboard_style.css`, `product-ui.css` (+ public mirrors) | List max-height 420px, row grid, count/empty/error styles. |
| `Temara_Dashboard/vercel.json` (+ public + root) | Rewrites `/api/acts` and `/api/acts/price`. |

Card behavior:

- Open Réglages (`#settings`) → `loadTarifsCabinet()`.
- Count: `107 actes NGAP · 4 hors nomenclature`.
- Custom acts first (Blanchiment, Consultation, Couronne zircone, Implant + couronne), then NGAP by code.
- Empty catalog → **Aucun acte tarifé.**
- HTTP/payload failure → **Tarifs indisponibles — réessayer** (list hidden) + retry.
- Price input: skip empty restore-to-saved, skip unchanged, lock `data-saving` while PUT runs, toast **Tarif enregistré** or **Prix invalide**.

---

## 5. Verification evidence

### Automated tests

`npm test` (static mirrors + `scripts/test-handlers-direct.js`): **364 passed, 0 failed, 0 skipped.** Static mirrors: 66 files OK.

New / extended coverage for chunk 1:

- Frontend: Tarifs card present on doctor settings, absent on assistant; load on settings open; never fail silently (error copy, retry id, `showTarifsCabinetError`, console status); list is `[...custom, ...reference]` not priced-only.
- Migration/seed: catalog tables applied; 107-row seed present; placeholder insert idempotent; custom acts stay unique.
- HTTP: GET acts 200 doctor and assistant; 107 codes including D700/D708/D773; custom Consultation; GET without cookie 401; assistant PUT 403; unknown `D999` 400; doctor PUT D700 upserts and GET reflects it (then restored to 400).

### Live HTTP (Job A)

Preview `https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app`, commit `affdf91b34631ec7d5a395630eb4c3863d72ecea`.

| Call | Status | Body |
| --- | ---: | --- |
| `GET /api/acts` no app session | 401 | `{ ok: false, error: "Unauthorized", code: "UNAUTHORIZED" }` |
| `GET /api/acts` doctor | 200 | `ok: true`, **107** reference, **4** custom (`Blanchiment`, `Consultation`, `Couronne zircone`, `Implant + couronne`), 12 priced NGAP (`D700=400`, `D708=400`, `D773=6000`) |
| `PUT` Consultation `price_mad: 260` then GET | 200 | Consultation `priceMad` 260 |
| Restore Consultation `250` | 200 | back to 250 |

Live `dashboard_app.js` contains `loadTarifsCabinet` (4) and `showTarifsCabinetError` (3); `switchTab` calls load when `viewKey === 'settings'`.

JSON dump: `/opt/cursor/artifacts/live-get-acts.json`.

### Live screenshots / video

All on `https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app/#settings` (doctor session).

| Artifact | What it shows |
| --- | --- |
| `live-tarifs-populated.webp` | Card populated: **107 actes NGAP · 4 hors nomenclature**; Blanchiment 3000, Consultation 250, Couronne zircone 4000, Implant + couronne 8000 |
| `live-tarifs-d700-400.webp` | D700 **400**, D701 500, D702 600 |
| `live-tarifs-d708-400.webp` | D708 **400** (with D705 1000, D706 1200) |
| `live-tarifs-d773-6000.webp` | D773 **6000** |
| `live-tarifs-consultation-260-toast.webp` | Consultation **260** + toast **Tarif enregistré** |
| `live-tarifs-consultation-260-after-reload.webp` | After full reload, Consultation still **260** |
| `live-tarifs-consultation-250-restored.webp` | Restored **250** + toast **Tarif enregistré** |
| `live_tarifs_cabinet_populated_and_price_persist.mp4` | Same flow on the live URL: populated card, D700/D773, edit 250→260, reload persist, restore 250 |

---

## 6. Deviations from the original spec

| Spec | What shipped | Why |
| --- | --- | --- |
| Dedicated `/api/acts` function files | Multiplex on `roster.js` + `roi-ops.js`; aliases only | Vercel Hobby 12/12 — a 13th function is forbidden |
| Seed placeholder by clinic UUID | `WHERE c.slug = 'temara'` | Portable across local/live UUIDs |
| Custom-act uniqueness via a second unique index | `NOT EXISTS` + `IS NOT DISTINCT FROM` (no second index) | Partial unique index cannot cover `act_code IS NULL`; agreed before execute |
| One migration containing catalog + insurance columns + `payments` | Chunk 1 migration is catalog + prices only | Chunks 2–3 stay separately deployable; unused tables were not created early |
| Tarifs list = priced NGAP + 4 custom | List = **all 107 NGAP** + 4 custom | Priced-only filter would still look empty-ish (16 rows) and blocked setting prices on unpriced codes; Job A required 107 NGAP visible |
| Lucide `banknote` | `circle-dollar-sign` | `banknote` is not in the bundled icon set (blank icon) |
| Load via assistant `navigateToView` | Doctor `dashboard_app.js` `switchTab` | Doctor Réglages never hit the assistant router; first deploy showed title-only even after data existed |
| Apply seed only locally | Prod tables created + seeded via Supabase (Job A) | Live card is the definition of done |
| RLS omitted on new tables | `deny_client_roles` + REVOKE, matching Data API lockdown | New tables must not be readable through PostgREST `anon`/`authenticated` |

Handler/query discipline from the Vercel React guide (no React rewrite): auth/role inside the action, cheap validation before DB, one catalog query instead of two round-trips.

---

## 7. Known issues and open TODOs

From the migration header (`TODO(verify)` — not implemented, not guessed):

1. 2nd coefficient on some surgical acts (D622, D726, D729–D732, D741, D745–D747)
2. CNSS coverage of periodontal acts D709–D711
3. Consultation TNR (150 vs 250 MAD post-2020) — catalog TNR vs cabinet placeholder 250
4. Dental reimbursement rate 70% vs 80% (`PATIENT_SHARE` still `cnss: 0.3` / `cnops: 0.2` in `treatments.js`)

Discovered during the empty-card fix:

- **Local green ≠ live.** `npm test` against the agent database does not apply DDL to Supabase. A chunk is not done until the Vercel `DATABASE_URL` database has the tables **and** the preview shows them.
- Production `dashboard-shabi1.vercel.app` is still `main`. Doctors using production will not see Tarifs until this branch is merged and promoted.
- Preview is behind Vercel Deployment Protection. Unauthenticated `curl` hits SSO, not the app 401.
- There is no UI to **create** a new custom act; PUT can insert a new `custom_label`, but the card only edits existing rows.
- Long list uses overflow scroll, not `content-visibility` (acceptable at 111 rows).
- `GET /api/acts` is allowed for assistants (needed for future sheets) but the assistant settings page has no editor — by design.

`treatments.js` already has a `PATIENT_SHARE` map. Chunk 3 still owes the one-line TODO comment; values must not change.

---

## 8. What remains

Standing rule: **done means verified on the live deployment with a screenshot.** Local tests are not sufficient.

### Chunk 2 — Insurance profile v2

Scope: four additive `patients` columns (do **not** change `insurance_type` CHECK): `insurance_member_number`, `mutuelle_name`, `beneficiary_of_patient_id` (FK `patients(id) ON DELETE SET NULL`), `beneficiary_relation` CHECK `conjoint|enfant|parent` or NULL.

Files expected: `supabase/migrations/` (new additive file or extension), `supabase/schema.sql`, `scripts/dev-schema.sql`, `Temara_Dashboard/api/_lib/roi-ops.js` (`mapPatient`, `handlePatientPatch`), `Temara_Dashboard/api/roster.js` (GET patient + directory mapping), patient export (Loi 09-08 — these fields, no CIN/address), `Temara_Dashboard/carnet.js`, CRM sheet in `index.html` and `assistant-shell.html`, `scripts/test-handlers-direct.js`, `npm run sync-static`.

Sheet (Identité, French): existing `insurance_type` select (`none`/`cnss`/`cnops`/`prive`) if missing, **N° adhérent**, **Mutuelle**, **Ayant droit de**, **Lien**. Include in PATCH. No member-number format validation.

Acceptance: PATCH persists four fields; invalid relation 400; cross-clinic beneficiary 400; GET camelCase + snake_case consistent with `insurance_type` / `insuranceType`; live screenshot of the carnet sheet with saved values after reload.

### Chunk 3 — Payments

Scope: `payments` table (`amount_mad > 0`; method `especes|cheque|carte|virement`; no UPDATE/DELETE; index `(clinic_id, patient_id, paid_at DESC)`). `GET/POST /api/roster?action=payments` (do **not** alias in a way that drops `patient_id`). Sheet **Règlements** under Comptes. Honoraires stay `SUM(charge_mad)`. No solde/impayés. Load payments in parallel with visit history (`Promise.all`). `PATIENT_SHARE` TODO comment only.

Acceptance: GET empty array; POST 200; GET includes row; assistant can POST; missing amount 400; other-clinic patient 404; no cookie 401; live screenshot of a recorded payment on the patient sheet.

Out of scope for both: feuille de soins, devis, invoices, CMI, refunds, Calendar OS, new npm deps, new Vercel function file.

---

## 9. How to reproduce / verify

Replace `$DATABASE_URL` with the **Vercel** connection string (not a local Docker URL). Clinic slug must be `temara`.

### Schema + seed

```bash
psql "$DATABASE_URL" -c "SELECT to_regclass('public.act_reference'), to_regclass('public.clinic_act_prices');"
# If NULL, apply:
psql "$DATABASE_URL" -f supabase/migrations/20260919_phase0_foundations.sql

psql "$DATABASE_URL" -c "SELECT count(*) FROM act_reference;"   # expect 107
# If 0:
psql "$DATABASE_URL" -f supabase/seeds/act_reference_seed.sql

# Re-run placeholder prices (idempotent). If the live slug is not temara, edit the WHERE clause.
psql "$DATABASE_URL" -f supabase/migrations/20260919_phase0_foundations.sql

psql "$DATABASE_URL" -c "SELECT count(*) FROM clinic_act_prices;"  # expect 16
psql "$DATABASE_URL" -c "SELECT id, slug FROM clinics;"
```

### Tests + static mirrors

```bash
npm run sync-static
npm test
# expect: Static mirrors OK, Direct handler results: 364 passed, 0 failed
```

### Endpoints (after `POST /api/auth` as `docteur` / `dentaflow`, cookie `dentaflow_session`)

```bash
# 401
curl -sS -D- https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app/api/acts

# 200 — 107 + 4
curl -sS -b cookies.txt https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app/api/acts
# equivalent: /api/roster?action=acts

# assistant PUT → 403
curl -sS -b assistant.txt -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"act_code":"D700","price_mad":410}' \
  https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app/api/acts/price

# doctor PUT + GET
curl -sS -b doctor.txt -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"custom_label":"Consultation","price_mad":260}' \
  https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app/api/acts/price

# unknown code → 400
curl -sS -b doctor.txt -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"act_code":"D999","price_mad":10}' \
  https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app/api/acts/price
```

Preview URLs are behind Vercel Authentication; raw curl without a protection bypass hits SSO, not the app. Confirm the app 401 vs 200 only after that wall is passed.

### UI

1. Open the **preview** URL for `cursor/phase0-foundations-417c` (not production `main`).
2. Log in Médecin: `docteur` / `dentaflow`.
3. Réglages. Card must show **107 actes NGAP · 4 hors nomenclature** and the four custom prices.
4. Scroll the list for D700 400 / D708 400 / D773 6000.
5. Change Consultation, blur, wait for **Tarif enregistré**, reload, confirm the value stuck, then restore 250.
6. Forced error (optional): break the session and reopen Réglages — **Tarifs indisponibles — réessayer**.
