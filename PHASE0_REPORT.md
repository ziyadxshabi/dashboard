# Phase 0 report — billing/insurance data foundations

Owner-facing record of Phase 0 through chunks 1–3. French UI copy is left in French. Three additive commits on `cursor/phase0-foundations-417c`.

| Chunk | Commit | Status |
| --- | --- | --- |
| 1 Act catalog | `affdf91` / `7375a75` | Live Tarifs card on preview `dpl_3P1b6KbA8Fe7bs582cQBntG5Azbt` |
| 2 Insurance v2 | `91742d4` | Carnet Identité on local doctor + assistant |
| 3 Payments | `259d193` | Carnet Règlements on local doctor + assistant |

Hobby stays at 12/12. No new file under `Temara_Dashboard/api/`. Calendar OS frozen. `bookings.charge_mad` and CNSS 70/30 unchanged.

---

## 1. Scope recap

- **Chunk 1 — Act catalog:** 107 NGAP rows in `act_reference`, 16 placeholder prices on slug `temara`, `GET /api/acts` + `PUT /api/acts/price` through roster, doctor Tarifs cabinet card.
- **Chunk 2 — Insurance profile v2:** four additive `patients` columns; PATCH/GET/export; Identité sheet on doctor and assistant (Assurance, N° adhérent, Mutuelle, Ayant droit de, Lien).
- **Chunk 3 — Payments:** `payments` table (money-in only); `GET/POST /api/roster?action=payments`; Règlements block under Comptes; `PATIENT_SHARE` TODO comment only.

Out of scope (still): feuille de soins, devis, invoices, CMI, refunds, impayés/solde, Calendar OS, new npm deps, 13th Vercel function.

---

## 2. Database

**Supabase project:** `dentaflow-dev` (`kiplbaajxvhiehjgzmor`). Vercel `DATABASE_URL` on `dashboard-shabi1`.

**Migration file:** `supabase/migrations/20260919_phase0_foundations.sql` (idempotent). Applied on prod as:

- `phase0_foundations` (catalog)
- `phase0_insurance_v2` (patient columns)
- `phase0_payments` (payments table)

Prod already had `phase0_foundations`, so insurance/payments DDL was applied as separately named migrations against the same SQL.

**Seed:** `supabase/seeds/act_reference_seed.sql` (107 verbatim NGAP `INSERT … ON CONFLICT DO NOTHING`). Not inlined in the migration.

**Mirrors:** `supabase/schema.sql` (UUID `clinic_id` + RLS) and `scripts/dev-schema.sql` (`clinic_id TEXT`, no RLS).

`act_reference` is the intentional global exception to `clinic_id` tenancy. `clinic_act_prices` and `payments` are clinic-scoped. Catalog rows are deactivated, never deleted.

### Catalog (chunk 1)

`act_reference`: PK `code`; `label`, `category`, `coefficient`, `letter_key`, `tnr_mad`, `requires_prior_approval`, `active`.

`clinic_act_prices`: `clinic_id` FK; `act_code` **or** `custom_label`; `price_mad >= 0`; `active`; partial unique `(clinic_id, act_code) WHERE act_code IS NOT NULL`. Custom rows use `NOT EXISTS` + `IS NOT DISTINCT FROM` (no second unique index).

Placeholder prices (`WHERE c.slug = 'temara'`): 12 NGAP + Consultation 250, Blanchiment 3000, Implant + couronne 8000, Couronne zircone 4000.

Prod after Job A: 107 `act_reference` rows, 16 `clinic_act_prices` rows, clinic `4abc388e-18d4-4abe-8dcd-c529d6407e4f` / slug `temara`.

### Insurance v2 (chunk 2)

On `patients` (do **not** touch `insurance_type` CHECK `none|cnss|cnops|prive`):

| Column | Type | Notes |
| --- | --- | --- |
| `insurance_member_number` | `TEXT` | free text, no format validation |
| `mutuelle_name` | `TEXT` | free text |
| `beneficiary_of_patient_id` | `UUID` | FK `patients(id) ON DELETE SET NULL` |
| `beneficiary_relation` | `TEXT` | CHECK `conjoint\|enfant\|parent` or NULL |

Index `idx_patients_beneficiary` on `(clinic_id, beneficiary_of_patient_id) WHERE beneficiary_of_patient_id IS NOT NULL`.

### Payments (chunk 3)

| Column | Notes |
| --- | --- |
| `amount_mad` | `NUMERIC(12,2) > 0` |
| `method` | `especes\|cheque\|carte\|virement` |
| `booking_id` / `plan_id` | optional, same-clinic |
| `note` | optional |
| `paid_at` | default `now()` |
| `created_by` | `staff_users(id)` = JWT `session.sub` |

Index `(clinic_id, patient_id, paid_at DESC)`. No UPDATE/DELETE. RLS `deny_client_roles` + REVOKE like catalog (prod). Staff access is the Node `postgres` pool (`BYPASSRLS`).

Migration header TODOs (not implemented, not guessed):

1. 2nd coefficient on some surgical acts (D622, D726, D729–D732, D741, D745–D747)
2. CNSS coverage of periodontal acts D709–D711
3. Consultation TNR (150 vs 250 MAD post-2020)
4. Dental reimbursement rate 70% vs 80%

---

## 3. API

All multiplexed on `Temara_Dashboard/api/roster.js` + `Temara_Dashboard/api/_lib/roi-ops.js`. Session cookie `dentaflow_session`. Parameterized SQL. Cheap auth/validation before DB.

Pretty aliases (cannot drop query strings):

- `/api/acts` → `/api/roster?action=acts`
- `/api/acts/price` → `/api/roster?action=act-price`

Payments stay `/api/roster?action=payments&patient_id=` (a rewrite to `?action=payments` would overwrite `patient_id`). GET payments is dispatched **before** generic `patient_id` visit history.

### `GET /api/acts` — doctor + assistant

One SQL: `act_reference` `LEFT JOIN clinic_act_prices` plus custom rows (`act_code IS NULL`). Skip inactive reference rows. `{ ok, data: { reference, custom } }` with `code`, `label`, `category`, `coefficient`, `letter_key`, `tnrMad`, `requiresPriorApproval`, `priceMad`, `priceId`, `insurable`.

### `PUT /api/acts/price` — doctor only (assistant 403)

Body `{ act_code?, custom_label?, price_mad, active? }`. Upsert on `(clinic_id, act_code)` when code set; insert custom when label set. `active: false` deactivates, never DELETE. Unknown code 400.

### `PATCH /api/roster?action=patient` — insurance v2

Whitelist via `hasOwnProperty` (`hasBodyKey`). `beneficiary_relation` allowlist. `beneficiary_of_patient_id` must be a same-clinic patient or 400. Invalid relation 400. GET patient + directory + Loi 09-08 export include the four fields (no CIN/address). Snake + camel aliases consistent with `insurance_type` / `insuranceType`.

### `GET/POST /api/roster?action=payments` — doctor + assistant

GET: `patient_id` required UUID; missing/invalid 400; other-clinic/unknown 404; `{ ok, data: [] }`.

POST: `{ patient_id, amount_mad, method, booking_id?, plan_id?, note? }`. Verify patient (and optional booking/plan) belong to `session.clinic_id` before insert. `created_by = session.sub`. Missing amount 400. No PATCH/DELETE.

---

## 4. UI

Vanilla JS. `npm run sync-static` copies `Temara_Dashboard/*` → `public/`.

| Surface | Change |
| --- | --- |
| Doctor Réglages | **Tarifs cabinet**: load GET acts when settings opens (not on boot). 107 NGAP + 4 custom. Save PUT. Error/retry copy. |
| Assistant Réglages | No price editor. |
| Doctor + assistant carnet Identité | Assurance ghost-select (`none/cnss/cnops/prive`), N° adhérent, Mutuelle, Ayant droit de, Lien (`conjoint\|enfant\|parent`). Included in PATCH. |
| Doctor + assistant carnet Comptes | **Règlements**: list `paid_at · method · amount MAD · note`; compact add (amount, method, note, Enregistrer `type=button`). Load visits + payments with `Promise.all`. Honoraires stay `SUM(charge_mad)`. No solde. |

---

## 5. Verification

### Automated

`npm test`: **389 passed, 0 failed, 0 skipped.** Static mirrors OK.

Chunk 1: GET acts 200 both roles; 107 codes include D700/D708/D773; custom Consultation; assistant PUT 403; doctor PUT upsert D700; unknown code 400.

Chunk 2: PATCH persists four fields; invalid relation 400; cross-clinic beneficiary 400; GET camelCase + snake_case; export includes fields; Identité markup on doctor + assistant.

Chunk 3: GET empty array; POST 200; GET includes row; assistant can POST; missing amount 400; other-clinic 404; GET/POST without cookie 401; Règlements contracts; `Promise.all` load; `PATIENT_SHARE` TODO present and `cnss: 0.3` unchanged.

Smoke (`scripts/smoke-test.js`): GET acts + GET payments 401/200. Pre-existing waitlist consent 400s are out of scope.

### Local HTTP (dev server on `:3000`, after restart onto `259d193`)

Against local Postgres (`clinics.slug = temara`, Fatima `aeba8727-ac57-4041-b877-4c3b8f7cbf87`):

| Call | Result |
| --- | --- |
| GET payments no cookie | 401 `UNAUTHORIZED` |
| GET payments | 200 `data: []` then, after POST, includes the row |
| POST 150 `especes` doctor | 200 |
| POST missing amount | 400 `amount_mad is required` |
| PATCH insurance v2 | 200; GET returns snake + camel aliases + `beneficiary_name` Youssef Benjelloun |
| POST 75 `carte` assistant | 200 |
| Assistant PUT act-price | 403 |
| GET acts | 107 reference including D700/D708/D773; custom Consultation 250 |

Log: `/opt/cursor/artifacts/phase0_local_api_check.log`.

### Local UI (doctor)

`http://127.0.0.1:3000/#crm`, `docteur` / `dentaflow`, Fatima El Amrani:

- Identité: Assurance CNSS, N° adhérent saved `CNSS-FATIMA-001` → UI edit **CNSS-FATIMA-UI**, Mutuelle **AXA Santé**, Ayant droit de **Youssef Benjelloun**, Lien **Conjoint**. Persist after close/reopen.
- Règlements: UI add **200 MAD · Chèque · carnet-ui**. Honoraires saisis stayed **1350 MAD** (no solde). List format `paid_at · method · amount MAD · note`.

### Local UI (assistant)

`assistante` / `dentaflow`, same dossier:

- Identité shows the saved insurance v2 values.
- UI add **50 MAD · Virement · assistant-ui**. Honoraires still **1350 MAD**.

DB after UI: `display_name` still Fatima El Amrani; four payments (150 espèces, 75 carte, 200 chèque, 50 virement).

### Live preview

Chunk 1 Tarifs was verified on `https://dashboard-shabi1-p6zlaotak-shabi1.vercel.app` (commit `affdf91`). Later previews for chunks 2–3 are behind Vercel Deployment Protection (SSO). Unauthenticated curl hits SSO, not the app 401. Local doctor/assistant carnet is the UI proof for chunks 2–3. Prod schema for insurance columns + `payments` was applied via Supabase.

---

## 6. Deviations from the spec

| Spec | What shipped | Why |
| --- | --- | --- |
| Dedicated `/api/acts` function files | Multiplex on `roster.js` | Hobby 12/12 |
| Seed placeholder by clinic UUID | `WHERE c.slug = 'temara'` | Portable across local/live UUIDs |
| Custom-act uniqueness via a second unique index | `NOT EXISTS` + `IS NOT DISTINCT FROM` | Partial unique cannot cover `act_code IS NULL` |
| One migration containing all three chunks from day one | One file, applied as three named prod migrations | Chunks separately deployable; prod already had catalog |
| Tarifs list = priced NGAP + 4 custom | All **107 NGAP** + 4 custom | Job A required unpriced codes to be editable |
| Lucide `banknote` | `circle-dollar-sign` | `banknote` not in the bundled set |
| Chunk 2–3 “done means live screenshot” | Local UI + prod DDL | Preview SSO blocked share-link browser proof |

Handler discipline: auth/role inside the action, cheap validation before DB, one catalog query, `Promise.all` for visits+payments and for optional booking/plan checks.

---

## 7. Known issues / open TODOs

From the migration header (not implemented):

1. 2nd coefficient on surgical acts listed above
2. CNSS coverage of D709–D711
3. Consultation TNR 150 vs 250
4. 70% vs 80% dental reimbursement (`PATIENT_SHARE` still `cnss: 0.3` / `cnops: 0.2`)

Also:

- Production alias `https://dashboard-shabi1.vercel.app` is still `main` until this branch is merged and promoted.
- Preview Authentication: raw curl without bypass hits SSO.
- No UI to **create** a new custom act; PUT can insert a label, the Tarifs card only edits existing rows.
- Chrome password-manager overlay on local assistant login; not product code.
- `GET /api/acts` is allowed for assistants (future sheets) but assistant settings has no editor.

---

## 8. How to reproduce

```bash
# local
psql "$DATABASE_URL" -c "SELECT to_regclass('public.act_reference'), to_regclass('public.payments');"
psql "$DATABASE_URL" -c "SELECT count(*) FROM act_reference;"   # 107
npm run sync-static
npm test   # 389 passed

# login
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"docteur","password":"dentaflow","role":"doctor"}' \
  http://127.0.0.1:3000/api/auth

curl -b cookies.txt http://127.0.0.1:3000/api/acts
curl -b cookies.txt 'http://127.0.0.1:3000/api/roster?action=payments&patient_id=<uuid>'
```

UI: Médecin `docteur` / `dentaflow` → Dossiers Patients → open a linked patient → Identité insurance fields → Comptes / Règlements → add a payment. Repeat as Assistant(e) `assistante` / `dentaflow`. Réglages (doctor only) for Tarifs cabinet.
