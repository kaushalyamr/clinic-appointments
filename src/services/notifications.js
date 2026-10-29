'use strict';
const config = require('../config');
const clock = require('../clock');
const { doctorLabel } = require('../names');

/** Upcoming booked appointments for this user that start inside the reminder window. */
function dueReminders(db, userId, { tz, current, windowMinutes }) {
  const horizon = current.instant + windowMinutes * 60_000;
  const rows = db
    .prepare(
      `SELECT a.id, a.date, a.start_time, a.patient_id, a.doctor_id,
              du.name AS doctor_name, pu.name AS patient_name
         FROM appointments a
         JOIN users du ON du.id = a.doctor_id
         JOIN users pu ON pu.id = a.patient_id
        WHERE (a.patient_id = ? OR a.doctor_id = ?) AND a.status = 'booked'`,
    )
    .all(userId, userId);

  const out = [];
  for (const row of rows) {
    const startsAt = clock.toInstant(tz, row.date, row.start_time);
    if (startsAt <= current.instant || startsAt > horizon) continue;
    const minutes = Math.max(0, Math.round((startsAt - current.instant) / 60_000));
    const when = row.date === current.date ? 'today' : `on ${row.date}`;
    const who = userId === row.patient_id ? `with ${doctorLabel(row.doctor_name)}` : `for ${row.patient_name}`;
    out.push({
      appointment_id: row.id,
      minutes,
      message: `Reminder: your appointment ${who} ${when} at ${row.start_time} starts in ${minutes} min.`,
    });
  }
  return out;
}

/** Write one in-app reminder per appointment; dedupe_key makes this idempotent. */
function syncReminders(db, userId, options = {}) {
  const tz = options.tz ?? config.load().timezone;
  const current = options.current ?? clock.now(tz);
  const windowMinutes = options.windowMinutes ?? config.load().reminderWindowMinutes;
  for (const item of dueReminders(db, userId, { tz, current, windowMinutes })) {
    db.prepare(
      `INSERT OR IGNORE INTO notifications (user_id, appointment_id, kind, message, dedupe_key, created_at)
       VALUES (?, ?, 'reminder', ?, ?, ?)`,
    ).run(userId, item.appointment_id, item.message, `reminder:${item.appointment_id}`, new Date().toISOString());
  }
}

function list(db, userId) {
  return db
    .prepare(
      `SELECT id, appointment_id, kind, message, created_at, read_at
         FROM notifications WHERE user_id = ?
        ORDER BY read_at IS NOT NULL, id DESC LIMIT 50`,
    )
    .all(userId);
}

/** ids = null marks everything read. */
function markRead(db, userId, ids) {
  const stamp = new Date().toISOString();
  if (ids === null) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(stamp, userId);
    return list(db, userId);
  }
  const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
  for (const id of ids) stmt.run(stamp, userId, Number(id));
  return list(db, userId);
}

module.exports = { syncReminders, list, markRead, dueReminders };
