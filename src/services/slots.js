'use strict';
// Slot generation. The pure part (slotsFromRules) knows nothing about the DB,
// which is what makes it easy to unit test.

const clock = require('../clock');

/**
 * @param {object} input
 * @param {Array<{weekday:number,start_time:string,end_time:string}>} input.rules
 * @param {number} input.slotMinutes
 * @param {string} input.date  target clinic date (YYYY-MM-DD)
 * @param {{date:string,minutes:number}} input.current  clinic "now"
 * @param {boolean} [input.blocked]
 * @returns {{slots: Array, closed: ?string}}
 */
function slotsFromRules({ rules, slotMinutes, date, current, blocked = false }) {
  const result = { slots: [], closed: null };

  if (clock.diffDays(current.date, date) < 0) return { slots: [], closed: 'past' };
  if (blocked) return { slots: [], closed: 'blocked' };

  const weekday = clock.weekdayOf(date);
  const windows = rules
    .filter((r) => Number(r.weekday) === weekday)
    .sort((a, b) => clock.toMinutes(a.start_time) - clock.toMinutes(b.start_time));

  if (windows.length === 0) return { slots: [], closed: 'no_availability' };

  for (const window of windows) {
    const from = clock.toMinutes(window.start_time);
    const to = clock.toMinutes(window.end_time);
    // A slot must fit entirely inside its window; leftover minutes are dropped.
    for (let start = from; start + slotMinutes <= to; start += slotMinutes) {
      const isToday = date === current.date;
      if (isToday && start <= current.minutes) continue; // never offer past slots
      result.slots.push({
        start: clock.toTime(start),
        end: clock.toTime(start + slotMinutes),
        startMinutes: start,
        endMinutes: start + slotMinutes,
        window: `${window.start_time}-${window.end_time}`,
      });
    }
  }

  if (result.slots.length === 0 && date === current.date) result.closed = 'fully_past';
  return result;
}

function doctorContext(db, doctorId) {
  const doctor = db
    .prepare(
      `SELECT u.id, u.name, u.role, p.specialty, p.bio, p.consultation_fee_cents,
              p.slot_length_minutes, p.horizon_days
         FROM users u JOIN doctor_profiles p ON p.user_id = u.id
        WHERE u.id = ? AND u.role = 'doctor'`,
    )
    .get(doctorId);
  return doctor ?? null;
}

function rulesFor(db, doctorId) {
  return db
    .prepare('SELECT weekday, start_time, end_time FROM availability_rules WHERE doctor_id = ?')
    .all(doctorId);
}

function isBlocked(db, doctorId, date) {
  return Boolean(
    db.prepare('SELECT 1 AS hit FROM blocked_days WHERE doctor_id = ? AND date = ?').get(doctorId, date),
  );
}

function bookedStarts(db, doctorId, date) {
  return db
    .prepare("SELECT start_time FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'booked'")
    .all(doctorId, date)
    .map((r) => r.start_time);
}

/**
 * Free, bookable slots for one doctor on one date.
 * Availability - blocked days - past slots - already booked slots.
 */
function freeSlots(db, { doctorId, date, tz, current = clock.now(tz) }) {
  const doctor = doctorContext(db, doctorId);
  if (!doctor) return { doctor: null, slots: [], closed: 'unknown_doctor' };

  const { slots, closed } = slotsFromRules({
    rules: rulesFor(db, doctorId),
    slotMinutes: doctor.slot_length_minutes,
    date,
    current,
    blocked: isBlocked(db, doctorId, date),
  });

  const taken = new Set(bookedStarts(db, doctorId, date));
  const free = slots.filter((s) => !taken.has(s.start)).map((s) => ({ ...s, date }));
  return { doctor, slots: free, closed: free.length === 0 ? closed ?? 'fully_booked' : null };
}

module.exports = { slotsFromRules, freeSlots, doctorContext, rulesFor, isBlocked, bookedStarts };
