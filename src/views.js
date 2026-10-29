'use strict';
const config = require('./config');
const clock = require('./clock');

/**
 * Row -> JSON for the UI. The server sends an absolute instant (starts_at) plus
 * the clinic wall-clock strings; the browser formats using CLINIC_TIMEZONE so a
 * phone in another zone still shows "Tue 10:30" the way the clinic means it.
 */
function appointmentView(row, { tz = config.load().timezone, current = clock.now(tz), actor, guardMinutes = config.load().rescheduleGuardMinutes } = {}) {
  const startsAt = clock.toInstant(tz, row.date, row.start_time);
  const minutesAway = Math.round((startsAt - current.instant) / 60_000);
  const booked = row.status === 'booked';
  const patientSide = actor?.role === 'patient' && booked;
  return {
    ...row,
    starts_at: new Date(startsAt).toISOString(),
    minutes_away: minutesAway,
    hours_until_guard: Math.floor((minutesAway - guardMinutes) / 60),
    can_cancel: booked && (actor?.role === 'doctor' || minutesAway >= guardMinutes),
    can_reschedule: patientSide && minutesAway >= guardMinutes,
    can_close: booked && actor?.role === 'doctor' && startsAt <= current.instant,
  };
}

function groupAppointments(rows, options) {
  const tz = options.tz ?? config.load().timezone;
  const current = options.current ?? clock.now(tz);
  const views = rows.map((row) => appointmentView(row, { tz, current, ...options }));
  const upcoming = views.filter((row) => row.status === 'booked' && row.minutes_away >= 0);
  const past = views.filter((row) => !upcoming.includes(row));
  upcoming.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  past.sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  return { upcoming, past };
}

module.exports = { appointmentView, groupAppointments };
