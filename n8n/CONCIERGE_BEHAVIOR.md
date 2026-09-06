# Concierge + waitlist behavior spec

Extracted from `Production Concierge Engine v2.json` and `No-Show Waitlist Engine (1).json`. Port must keep this product logic; stores and auth are adapted (Baserow/Sheets → Postgres, `x-agency-auth`/PIN → JWT).

## Event matrix

| Cal.com `triggerEvent` | Postgres | Patient SMS | Email (fail-open) | Slack (fail-open) | Waitlist |
| --- | --- | --- | --- | --- | --- |
| `BOOKING_CREATED` | upsert `Confirme` | confirm copy | confirmation | `✅ Nouveau RDV` only if Twilio SID | none |
| `BOOKING_CANCELLED` | `Annule` | **none** (staff Slack only) | cancellation | cancelled slot | top-3 + NX |
| `BOOKING_RESCHEDULED` | update `starts_at` | reschedule copy | reschedule | modified slot | none |

Staff `Annule` on a visit uses the same waitlist blast (Postgres is SSOT; Cal is no longer the only cancel path).

## Idempotency (adapted)

n8n used `lock:booking:${uid}` **before** the switch. That blocked CANCELLED within 24h of CREATED. The port uses:

```
lock:booking:${uid}:${triggerEvent}
```

TTL 24h. Same NX intent (retries of the **same** event do not re-SMS) without swallowing later events.

Store: `notification_locks` (Postgres). Fail-open on lock errors for **ingest** (Cal write still succeeds). Skip notify when the lock is not acquired (no duplicate SMS).

Waitlist: `waitlist:notified:${e164}` NX 24h. Twilio status: `lock:twilio-sms:${MessageSid}` NX 24h.

## Waitlist blast (merged policy)

- Rank: Urgent 0, Haute 1, Moyenne/Normale 2, Faible/Basse 3, then `created_at`, then `id`
- Take **top 3** (Concierge) not top-1 (Waitlist Engine)
- Skip empty phone, skip `sms_consent = false`
- Per-phone NX 24h
- Copy: Concierge “créneau vient de se libérer aujourd'hui”
- Booking URL: `clinics.sms_booking_url` (not the old Google Sites portal)

## Moroccan E.164

```js
function toE164MA(raw) {
  if (raw == null || raw === '') return '';
  let phone = String(raw).replace(/[\s\-().]/g, '');
  if (!phone) return '';
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('00')) return '+' + phone.slice(2);
  if (phone.startsWith('212')) return '+' + phone;
  if (phone.startsWith('0')) return '+212' + phone.slice(1);
  return '+212' + phone;
}
```

## SMS copy (exact)

- **Confirm:** `Bonjour {NAME} ! 🦷\n\nVotre consultation à la Clinique Dentaire Témara Mall est bien confirmée. À très bientôt !`
- **Reschedule:** `Bonjour {NAME}, la modification de votre RDV a bien été prise en compte.`
- **Waitlist:** `Bonjour {NAME}, un créneau vient de se libérer aujourd'hui à la Clinique Dentaire Témara Mall. Cliquez rapidement ici pour réserver l'emplacement : {URL}`
- **Slot filled cleanup:** `Le créneau d'urgence du jour a été comblé, mais vous pouvez planifier une autre date directement via notre portail patient : {URL}`
- **T-24h:** `Bonjour {NAME}, nous vous rappelons votre consultation demain à la Clinique Dentaire Témara Mall. Pour gérer, modifier ou reporter votre visite, cliquez sur ce lien sécurisé : {URL}`
- **Force tomorrow:** `Bonjour {NAME}, rappel de votre rendez-vous demain à la Clinique Dentaire Témara Mall. Merci de confirmer votre présence.`
- **Bulk default:** `Bonjour {NAME}, ceci est un message du cabinet dentaire. Veuillez nous contacter si besoin.`
- **Leak J+3 / J+7 / J+14:** see Leak engine (Nom + Link substitution)
- **Voice digit 1:** portal SMS with STOP line

Never mark `sms_status = sent` (or show “SMS envoyé”) before Twilio returns a SID.

## Auth (intent unchanged)

| Surface | Keep |
| --- | --- |
| Cal webhook | HMAC-SHA256 `x-cal-signature-256`, timing-safe hex compare |
| Twilio inbound | `x-twilio-signature`, HMAC-SHA1(url + sorted body), timing-safe |
| Staff mutations | JWT `dentaflow_session` + `clinic_id` (replaces PIN / `x-agency-auth`) |
| Waitlist add | JWT required — n8n WF4 had no auth; that hole is **not** ported |
| Crons | `CRON_SECRET` bearer **or** staff JWT |

## Fail-open vs fail-closed

| Surface | Policy |
| --- | --- |
| Cal / Twilio signature | fail-closed 401 |
| Booking ingest (Postgres) | fail-closed 500 |
| Twilio / Resend / Slack send | fail-open |
| Notify NX duplicate | skip send, HTTP 200 |
| Login Redis | fail-open (unchanged) |

## Crons (Africa/Casablanca)

- Reminders: n8n `0 8 * * *` — window T-24h ± 30 min, status Confirmé/Confirme. Vercel UTC cron `0 7 * * *` (Casablanca UTC+1, no DST).
- Leak: n8n `0 9 * * *` — exact calendar age 3 / 7 / 14 days, status Annulé/No-show. Skip if the same phone already has a future visit. Vercel UTC cron `0 8 * * *`.

## Cal.com busy (Superpouvoir Block)

When a doctor creates a Postgres `block` / `emergency_hold`, optionally `POST https://api.cal.com/v1/bookings`. Postgres remains SSOT; Cal miss must not fail the block. Release/delete cancels the Cal booking when `cal_booking_uid` is set.
