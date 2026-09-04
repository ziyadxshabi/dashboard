/**
 * Dashboard KPI proxy — JWT-gated bridge to n8n via Ngrok.
 * Upstream failures return HTTP 502 via api/n8n.js.
 */
module.exports = require('./n8n');
