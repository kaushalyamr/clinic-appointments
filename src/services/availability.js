'use strict';
const config = require('../config');
const clock = require('../clock');
const { inTransaction } = require('./appointments');
const v = require('../validate');
const { ValidationError, NotFoundError } = require('../errors');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getWeekly(db, doctorId) {
  const profile = db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(doctorId);
  if (!profile) throw NotFoundError('Doctor profile not found.');
  const rules = db
    .prepare('SELECT id, weekday, start_time, end_time FROM availability_rules WHERE doctor_id = ? ORDER BY weekday, start_time')
    .all(doctorId);
  return { ...profile, rules };
}

/** Windows must be well-formed, long enough for one slot, and must not overlap. */
function normalizeRules(rawRules, slotMinutes) {
  if (!Array.isArray(rawRules)) throw ValidationError('Availability must be a list of time windows.');
  if (rawRules.length > 20) throw ValidationError('Too many availability windows (20 maximum).');

  const parsed = rawRules.map((rule, index) => {
    const weekday = v.weekday(rule?.weekday);
    const start = v.time(rule?.start_time, `Start time (window ${index + 1})`);
    const end = v.time(rule?.end_time, `End time (window ${index + 1})`);
    const length = clock.toMinutes(end) - clock.toMinutes(start);
    if (length <= 0) {
      throw ValidationError(`${DAY_NAMES[weekday]} ${start}-${end}: end time must be after the start time.`);
    }
    if (length < slotMinutes) {
      throw ValidationError(
        `${DAY_NAMES[weekday]} ${start}-${end} is shorter than the ${slotMinutes}-minute consultation length.`,
      );
    }
    return { weekday, start_time: start, end_time: end };
  });

  const byDay = new Map();
  for (const rule of parsed) {
    const list = byDay.get(rule.weekday) ?? [];
    list.push(rule);
    byDay.set(rule.weekday, list);
  }
  for (const [weekday, list] of byDay) {
    list.sort((a, b) => clock.toMinutes(a.start_time) - clock.toMinutes(b.start_time));
    for (let i = 1; i < list.length; i += 1) {
      if (clock.toMinutes(list[i].start_time) < clock.toMinutes(list[i - 1].end_time)) {
        throw ValidationError(
          `${DAY_NAMES[weekday]} has overlapping windows (${list[i - 1].start_time}-${list[i - 1].end_time} and ${list[i].start_time}-${list[i].end_time}).`,
        );
      }
    }
  }
  return parsed;
}

function setWeekly(db, doctorId, body) {
  const slotMinutes = v.slotLength(body.slot_length_minutes ?? body.slotLength);
  const rules = normalizeRules(body.rules ?? [], slotMinutes);
  const horizonDays = body.horizon_days === undefined ? undefined : v.integer(body.horizon_days, 'Booking horizon', { min: 1, max: 180 });
  const feeCents = body.consultation_fee_cents === undefined ? undefined : v.integer(body.consultation_fee_cents, 'Consultation fee', { min: 0, max: 1_000_000 });

  return inTransaction(db, () => {
    const profile = db.prepare('SELECT user_id FROM doctor_profiles WHERE user_id = ?').get(doctorId);
    if (!profile) throw NotFoundError('Doctor profile not found.');

    db.prepare(
      `UPDATE doctor_profiles SET slot_length_minutes = ?,
              horizon_days = COALESCE(?, horizon_days),
              consultation_fee_cents = COALESCE(?, consultation_fee_cents)
        WHERE user_id = ?`,
    ).run(slotMinutes, horizonDays ?? null, feeCents ?? null, doctorId);

    db.prepare('DELETE FROM availability_rules WHERE doctor_id = ?').run(doctorId);
    const insert = db.prepare(
      'INSERT INTO availability_rules (doctor_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)',
    );
    for (const rule of rules) insert.run(doctorId, rule.weekday, rule.start_time, rule.end_time);

    return { weekly: getWeekly(db, doctorId) };
  });
}

function listBlocked(db, doctorId, { tz = config.load().timezone } = {}) {
  const today = clock.now(tz).date;
  return db
    .prepare('SELECT date, reason FROM blocked_days WHERE doctor_id = ? AND date >= ? ORDER BY date')
    .all(doctorId, today);
}

function addBlocked(db, doctorId, { date, reason, tz = config.load().timezone }) {
  const d = v.date(date, 'Leave date');
  const text = reason ? v.text(reason, 'Reason', { max: 120 }) : 'leave';
  if (clock.diffDays(clock.now(tz).date, d) < 0) throw ValidationError('Leave date cannot be in the past.');
  db.prepare('INSERT OR IGNORE INTO blocked_days (doctor_id, date, reason) VALUES (?, ?, ?)').run(doctorId, d, text);
  return listBlocked(db, doctorId, { tz });
}

function removeBlocked(db, doctorId, date) {
  const d = v.date(date, 'Leave date');
  db.prepare('DELETE FROM blocked_days WHERE doctor_id = ? AND date = ?').run(doctorId, d);
  return listBlocked(db, doctorId);
}

module.exports = { getWeekly, setWeekly, normalizeRules, listBlocked, addBlocked, removeBlocked, DAY_NAMES };
