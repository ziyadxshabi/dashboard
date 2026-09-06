# n8n museum

Do **not** import these workflows into n8n. They dual-wrote Google Sheets / Baserow or were inactive wrappers.

| File | Replaced by |
| --- | --- |
| Workflow 1 Load Dashboard | `GET /api/dashboard-data`, `GET /api/roster` |
| Workflow 2 Two-Way Sync | `POST /api/update-status` |
| Workflow 2 Push (inactive) | deleted from runtime |
| Workflow 3 Team Notes | `GET\|POST /api/team-notes` |
| Workflow 4 Waitlist Pipeline | `GET\|POST /api/waitlist` (JWT — the unauthenticated n8n hole is **not** preserved) |
| Dashboard Data Endpoint | `GET /api/dashboard-data` |
| Superpouvoir Fill_Slot | `POST /api/fill-gap` + waitlist blast |
| Superpouvoir Block_Slot | Doctor blocks in `POST /api/roster` + optional Cal.com busy sync |
| Superpouvoir Force_SMS | `POST /api/bulk-sms` `{ action: "force-tomorrow" }` |
| DEPRECATED_waitlist_blueprint.bak | never import |
