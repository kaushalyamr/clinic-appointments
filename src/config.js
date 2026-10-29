'use strict';
const path = require('path');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function load() {
  return {
    port: num(process.env.PORT, 3000),
    dbPath: process.env.DB_PATH
      ? path.resolve(process.env.DB_PATH)
      : path.join(process.cwd(), 'data', 'clinic.db'),
    // Every "wall clock" decision (slot generation, past-slot filter, 2h rule)
    // is made in this zone so server and browser agree regardless of host TZ.
    timezone: process.env.CLINIC_TIMEZONE || 'Asia/Karachi',
    sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 24 * 7),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    rescheduleGuardMinutes: num(process.env.RESCHEDULE_GUARD_MINUTES, 120),
    reminderWindowMinutes: num(process.env.REMINDER_WINDOW_MINUTES, 60),
  };
}

module.exports = { load };
