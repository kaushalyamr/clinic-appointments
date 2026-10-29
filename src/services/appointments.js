'use strict';
// Booking rules live here: double-booking protection, the 2-hour
// cancel/reschedule guard, and doctor status updates.

const config = require('../config');
const clock = require('../clock');
const slots = require('./slots');
const { doctorLabel } = require('../names');
const { NotFoundError, ValidationError, ConflictError, ForbiddenError } = require('../errors');

const CANCELLED = 'cancelled';

/** SQLite transaction with a write lock taken up front (BEGIN IMMEDIATE). */
function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const out = work();
    db.exec('COMMIT');
    committed = true;
    return out;
  } finally {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* connection already gone */
      }
    }
  }
}

function isConstraintError(error) {
  return /UNIQUE constraint failed|_sqlite error/iu.test(String(error?.message ?? error));
}

function findAppointment(db, id) {
  return db
    .prepare(
      `SELECT a.*, u.name AS doctor_name, u2.name AS patient_name, u2.email AS patient_email,
              p.specialty, p.slot_length_minutes, p.horizon_days, p.consultation_fee_cents
         FROM appointments a
         JOIN users u ON u.id = a.doctor_id
         JOIN users u2 ON u2.id = a.patient_id
         JOIN doctor_profiles p ON p.user_id = a.doctor_id
        WHERE a.id = ?`,
    )
    .get(id);
}

function insertNotification(db, { userId, appointmentId, kind, message, dedupeKey }) {
  db.prepare(
    `INSERT OR IGNORE INTO notifications (user_id, appointment_id, kind, message, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, appointmentId ?? null, kind, message, dedupeKey, new Date().toISOString());
}

function assertWithinHorizon(doctor, date, current) {
  if (clock.diffDays(current.date, date) > doctor.horizon_days) {
    throw ValidationError(`${doctorLabel(doctor.name)} only takes bookings ${doctor.horizon_days} days ahead.`);
  }
}

function assertNotTooLateToChange(tz, appointment, current, guardMinutes) {
  const startsAt = clock.toInstant(tz, appointment.date, appointment.start_time);
  if (startsAt - current.instant < guardMinutes * 60_000) {
    const hours = guardMinutes / 60;
    throw ValidationError(
      `This appointment starts within ${hours} hour${hours === 1 ? '' : 's'} ` +
        `(${appointment.date} ${appointment.start_time}) and can no longer be cancelled or moved. ` +
        'Please call the clinic.',
    );
  }
}

/** Validate a requested (date, time) against live availability, inside the transaction. */
function resolveSlot(db, { doctorId, date, time, tz, current, ignoreAppointmentId = null }) {
  const doctor = slots.doctorContext(db, doctorId);
  if (!doctor) throw NotFoundError('Doctor not found.');
  assertWithinHorizon(doctor, date, current);

  const generated = slots.slotsFromRules({
    rules: slots.rulesFor(db, doctorId),
    slotMinutes: doctor.slot_length_minutes,
    date,
    current,
    blocked: slots.isBlocked(db, doctorId, date),
  });

  if (generated.closed === 'past') throw ValidationError('That date is in the past.');
  if (generated.closed === 'blocked') throw ValidationError('The doctor is on leave that day.');
  if (generated.closed === 'no_availability') {
    throw ValidationError('The doctor does not consult on that day. Pick another weekday.');
  }

  const match = generated.slots.find((s) => s.start === time);
  if (!match) {
    throw ValidationError(`${time} is not an open slot for this doctor on ${date}.`);
  }

  const taken = slots.bookedStarts(db, doctorId, date).filter((start) => {
    if (!ignoreAppointmentId) return true;
    const row = db
      .prepare("SELECT id FROM appointments WHERE doctor_id = ? AND date = ? AND start_time = ? AND status = 'booked'")
      .get(doctorId, date, start);
    return row?.id !== ignoreAppointmentId;
  });
  if (taken.includes(time)) {
    throw ConflictError('That slot has just been taken. Please choose another time.');
  }
  return { doctor, slot: match };
}

/**
 * Book a slot. All checks and the INSERT happen inside one IMMEDIATE
 * transaction, and the partial unique index uq_active_slot is the backstop.
 */
function bookAppointment(db, { doctorId, patientId, date, time, tz = config.load().timezone, current = clock.now(tz) }) {
  return inTransaction(db, () => {
    const { doctor, slot } = resolveSlot(db, { doctorId, date, time, tz, current });
    const id = require('../auth').newId('apt');
    const nowIso = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO appointments (id, doctor_id, patient_id, date, start_time, end_time, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
      ).run(id, doctorId, patientId, date, slot.start, slot.end, nowIso, nowIso);
    } catch (error) {
      if (isConstraintError(error)) {
        throw ConflictError('That slot has just been taken. Please choose another time.');
      }
      throw error;
    }
    insertNotification(db, {
      userId: patientId,
      appointmentId: id,
      kind: 'booking_confirmed',
      message: `Appointment confirmed with ${doctorLabel(doctor.name)} (${doctor.specialty}) on ${date} at ${slot.start}.`,
      dedupeKey: `booking_confirmed:${id}`,
    });
    return findAppointment(db, id);
  });
}

function loadOwned(db, id, actor) {
  const appointment = findAppointment(db, id);
  if (!appointment) throw NotFoundError('Appointment not found.');
  if (actor.role === 'doctor') {
    if (appointment.doctor_id !== actor.id) throw ForbiddenError('That is not one of your appointments.');
  } else if (appointment.patient_id !== actor.id) {
    throw ForbiddenError('That is not one of your appointments.');
  }
  return appointment;
}

function cancelAppointment(db, { id, actor, tz = config.load().timezone, current = clock.now(tz) }) {
  const guardMinutes = config.load().rescheduleGuardMinutes;
  return inTransaction(db, () => {
    const appointment = loadOwned(db, id, actor);
    if (appointment.status !== 'booked') {
      throw ValidationError(`This appointment is already ${appointment.status.replace('_', ' ')}.`);
    }
    if (actor.role === 'patient') assertNotTooLateToChange(tz, appointment, current, guardMinutes);
    db.prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?')
      .run(CANCELLED, new Date().toISOString(), id);
    return findAppointment(db, id);
  });
}

function rescheduleAppointment(db, { id, actor, date, time, tz = config.load().timezone, current = clock.now(tz) }) {
  const guardMinutes = config.load().rescheduleGuardMinutes;
  return inTransaction(db, () => {
    const appointment = loadOwned(db, id, actor);
    if (appointment.status !== 'booked') throw ValidationError('Only booked appointments can be moved.');
    assertNotTooLateToChange(tz, appointment, current, guardMinutes);
    if (appointment.date === date && appointment.start_time === time) {
      throw ValidationError('Pick a different time than the current appointment.');
    }
    const { slot } = resolveSlot(db, { doctorId: appointment.doctor_id, date, time, tz, current, ignoreAppointmentId: id });
    try {
      db.prepare(
        'UPDATE appointments SET date = ?, start_time = ?, end_time = ?, updated_at = ? WHERE id = ?',
      ).run(date, slot.start, slot.end, new Date().toISOString(), id);
    } catch (error) {
      if (isConstraintError(error)) throw ConflictError('That slot has just been taken. Please choose another time.');
      throw error;
    }
    insertNotification(db, {
      userId: appointment.patient_id,
      appointmentId: id,
      kind: 'rescheduled',
      message: `Appointment with ${doctorLabel(appointment.doctor_name)} moved to ${date} at ${slot.start}.`,
      dedupeKey: `rescheduled:${id}:${date}:${slot.start}`,
    });
    return findAppointment(db, id);
  });
}

function updateStatus(db, { id, actor, status, tz = config.load().timezone, current = clock.now(tz) }) {
  if (!['completed', 'no_show'].includes(status)) throw ValidationError('Status must be completed or no_show.');
  return inTransaction(db, () => {
    const appointment = loadOwned(db, id, actor);
    if (appointment.status !== 'booked') {
      throw ValidationError(`Cannot change an appointment that is already ${appointment.status.replace('_', ' ')}.`);
    }
    const startsAt = clock.toInstant(tz, appointment.date, appointment.start_time);
    if (startsAt > current.instant) throw ValidationError('You can only close an appointment once its time has arrived.');
    db.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return findAppointment(db, id);
  });
}

function listByPatient(db, patientId, { tz = config.load().timezone, current = clock.now(tz) } = {}) {
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS doctor_name, p.specialty, p.consultation_fee_cents
         FROM appointments a
         JOIN users u ON u.id = a.doctor_id
         JOIN doctor_profiles p ON p.user_id = a.doctor_id
        WHERE a.patient_id = ?
        ORDER BY a.date DESC, a.start_time DESC`,
    )
    .all(patientId);
  return splitByUpcoming(rows, tz, current);
}

function listByDoctor(db, doctorId, date) {
  return db
    .prepare(
      `SELECT a.*, u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone
         FROM appointments a JOIN users u ON u.id = a.patient_id
        WHERE a.doctor_id = ? AND a.date = ?
        ORDER BY a.start_time`,
    )
    .all(doctorId, date);
}

function splitByUpcoming(rows, tz, current) {
  const upcoming = [];
  const past = [];
  for (const row of rows) {
    const startsAt = clock.toInstant(tz, row.date, row.start_time);
    const minutesAway = Math.round((startsAt - current.instant) / 60_000);
    const view = { ...row, starts_at: new Date(startsAt).toISOString(), minutes_away: minutesAway };
    if (row.status === 'booked' && startsAt >= current.instant) upcoming.push(view);
    else past.push(view);
  }
  upcoming.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return { upcoming, past };
}

module.exports = {
  inTransaction,
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
  updateStatus,
  listByPatient,
  listByDoctor,
  findAppointment,
  resolveSlot,
  splitByUpcoming,
};
