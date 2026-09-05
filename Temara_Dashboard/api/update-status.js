/**
 * Appointment status update — clinic-scoped PostgreSQL write.
 * POST /api/update-status  (also PATCH /api/roster)
 */
'use strict';

module.exports = require('./_lib/update-booking-status');
