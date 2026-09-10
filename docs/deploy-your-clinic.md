# Deploy your clinic — DentaFlow OS

One-time license model: the cabinet pays for the software once, then **pays its own** Vercel, PostgreSQL, Twilio, and Cal.com bills. This is not a shared billed cloud and there is no card payment in the app.

Hobby Vercel: **12 serverless functions**. Do not add a 13th file under `Temara_Dashboard/api/`. `_lib/` and `_archive/` are not routes.

## 1. Create the project

1. Import `https://github.com/ziyadxshabi/dashboard` (or your fork) into Vercel.
2. Set **Root Directory** to `Temara_Dashboard`.
3. Framework: Other. No build command.
4. Do not deploy `_attic/` or `n8n/`.

## 2. Database

1. Create a PostgreSQL database. **Prefer an EU region** (for example Frankfurt / `eu-central-1`). Supabase and Vercel do not offer a Morocco region.
2. Apply the canonical schema:

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

3. Use the **transaction pooler on port 6543** in production.
4. Change the seed passwords for `docteur` and `assistante` immediately (`POST /api/auth/password` after login, or replace `staff_users.password_hash`).
5. Set `clinics.slug` and `clinics.name` to this cabinet. Public booking is `/book/<slug>`.
6. Set `clinics.cal_event_type_id` to the Cal.com event type (example `your-org/visit`).

Tenant isolation is `clinics.id` (UUID) on the JWT. A slug in `CLINIC_ID` is **not** accepted.

## 3. Vercel environment

Required:

- `DATABASE_URL`
- `JWT_SECRET` (≥ 32 random characters, unique per clinic)
- `CALCOM_WEBHOOK_SECRET` (production)

SMS / voice:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- `TWILIO_WEBHOOK_URL` = `https://<your-domain>/api/webhooks/twilio`

Optional: `RESEND_API_KEY`, `SLACK_WEBHOOK_URL`, `CRON_SECRET`, `CALCOM_API_KEY`, Upstash Redis for login rate limits.

Do not pin a global Vercel `regions` value in this repo: each clinic chooses its own region. Twilio and Cal.com remain extra-territorial; list them in the CNDP subprocessor / transfer file (`docs/legal/`).

## 4. Cal.com

1. Create the event type in Cal.com.
2. Webhook URL: `https://<your-domain>/api/webhooks/cal` (`BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`).
3. Secret must match `CALCOM_WEBHOOK_SECRET`.

Patients never write `bookings` from the browser. Cal.com does; the webhook upserts Postgres.

## 5. After go-live

- Open `/privacy.html` and `/terms.html` and keep the clinic contact details accurate.
- SMS is opt-in (Loi 09-08). Do not collect address or CIN.
- Staff can export or anonymize a dossier: `GET /api/roster?action=patient-export`, `POST /api/roster?action=patient-erase`.
- Invoice the 10 000 MAD license **outside** the app (DGI). No CMI in the product.
