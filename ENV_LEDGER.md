# DentaFlow OS — Environment Variables Ledger

> Last audited: 2026-08-14
> Auditor: Cursor AI (automated scan)
> Status: Complete — Phase 0

## Present in Vercel (Production + Preview, all Sensitive)

### Authentication (Server-only)
- [x] JWT_SECRET
- [x] DOCTOR_USERNAME
- [x] DOCTOR_PASSWORD_HASH
- [x] ASSISTANT_USERNAME
- [x] ASSISTANT_PASSWORD_HASH

### n8n Bridge (Server-only)
- [x] N8N_AUTH_KEY
- [x] N8N_AGENCY_AUTH_KEY
- [x] DASHBOARD_AUTH_KEY

### Redis (Server-only)
- [x] REDIS_CONNECTION_URL
- [x] REDIS_REST_TOKEN

## Missing in Vercel (Confirmed by Codebase Audit)

### n8n Webhook URLs — Currently Hardcoded as Fallbacks
These are hardcoded in serverless functions as `https://glade-rigor-perennial.ngrok-free.dev/webhook/...`

- [ ] N8N_WEBHOOK_DASHBOARD → used in `api/dashboard-data.js`, `api/n8n-proxy.js`
- [ ] N8N_WEBHOOK_ROSTER → used in `api/roster.js` (both dashboards)
- [ ] N8N_WEBHOOK_UPDATE_STATUS → used in `api/update-status.js` (both dashboards)
- [ ] N8N_WEBHOOK_DELAY_ALERT → used in `api/n8n-delay-alert.js` (both dashboards)
- [ ] N8N_WEBHOOK_FILL_GAP → used in `api/fill-gap.js`
- [ ] N8N_WEBHOOK_BULK_SMS → used in `api/bulk-sms.js`
- [ ] N8N_WEBHOOK_GET_NOTES → used in `api/team-notes.js`
- [ ] N8N_WEBHOOK_POST_NOTE → used in `api/team-notes.js`
- [ ] N8N_WEBHOOK_LEAD_CAPTURE → used in `api/lead-capture.js` (both portals)
- [ ] N8N_WEBHOOK_ASSISTANT_PROXY → TBD
- [ ] N8N_WAITLIST_WEBHOOK → `api/waitlist.js` (fails closed — no fallback)

### Baserow (Database)
- [ ] BASEROW_API_URL — may be in n8n only
- [ ] BASEROW_API_TOKEN — may be in n8n only
- [ ] BASEROW_TABLE_ID — may be in n8n only
- [ ] BASEROW_WAITLIST_TABLE_ID — may be in n8n only
- [ ] BASEROW_WAITLIST_BROADCAST_TABLE_ID — may be in n8n only
- [ ] BASEROW_LEADS_TABLE_ID — may be in n8n only

### Cal.com
- [ ] CAL_WEBHOOK_SECRET — n8n only
- [ ] CALCOM_API_KEY — n8n only (`$vars.CALCOM_API_KEY`)
- [ ] CALCOM_EVENT_TYPE_ID — n8n only
- [ ] CLINIC_URGENCY_EMAIL — n8n only

### Twilio
- [ ] N8N_TWILIO_AUTH_TOKEN — n8n only
- [ ] N8N_WEBHOOK_BASE_URL — hardcoded in n8n workflows as ngrok URL
- [ ] TWILIO_ACCOUNT_SID — n8n only
- [ ] TWILIO_FROM_NUMBER — n8n only

### Clinic Identity
- [ ] VERCEL_FRONTEND_URL — may be hardcoded or missing
- [ ] CLINIC_ID — n8n only
- [ ] WAITLIST_WORKFLOW_ID — n8n only

## Hardcoded Infrastructure URLs (Phase 2 Cleanup)

### Frontend Direct Calls (Bypass /api/* Proxies)
| File | Line | Hardcoded URL | Endpoint |
|------|------|---------------|----------|
| `Temara_Dashboard/app.js` | ~10 | `https://glade-rigor-perennial.ngrok-free.dev` | API_BASE |
| `Temara_Dashboard/dashboard_app.js` | ~167 | `https://glade-rigor-perennial.ngrok-free.dev` | API_BASE |
| `Temara_Assistant_Dashboard/app.js` | ~7 | `https://glade-rigor-perennial.ngrok-free.dev` | API_BASE |

### Serverless Fallback URLs (When env missing)
All `api/*.js` files fall back to `https://glade-rigor-perennial.ngrok-free.dev/webhook/...`

### n8n Workflow Hardcoded URLs
Twilio status callbacks in multiple `.json` workflow files point to ngrok.

## Security Findings (Phase 1 Priority)
| Finding | Risk | File |
|---------|------|------|
| JWT in sessionStorage (`dentaflow_session`) | **CRITICAL** | `auth.js` (frontend) |
| Settings password in localStorage | MEDIUM | `dashboard_app.js` ~1199 |
| `ngrok-skip-browser-warning` header in frontend | LOW | Multiple app.js files |

## Phase 1 Readiness
- [x] JWT_SECRET confirmed present — required for httpOnly cookie signing
- [x] REDIS confirmed present — required for session storage
- [x] All auth credentials confirmed present
- [x] Codebase audit complete — no hardcoded secrets in frontend
- [ ] sessionStorage → httpOnly cookie migration required (NEXT)

## Phase 2 Scope (After Phase 1)
- [ ] Add N8N_WEBHOOK_* env vars to Vercel
- [ ] Remove hardcoded API_BASE from frontend files
- [ ] Route all frontend calls through /api/* proxies only
- [ ] Remove ngrok fallback URLs from serverless functions
- [ ] Update n8n workflow JSON files with proper webhook URLs
