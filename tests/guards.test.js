'use strict';
process.env.DB_PATH = require('./helpers').freshDbPath('guards');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const auth = require('../src/auth');
const {
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
  updateStatus,
} = require('../src/services/appointments');
const { freeSlots } = require('../src/services/slots');
const { fakeNow, makeDoctor, makePatient, TZ } = require('./helpers');

// Monday 2026-11-02, 10:00-13:00 + 17:00-20:00, 30-minute slots.
const MONDAY = '2026-11-02';
const NEXT_MONDAY = '2026-11-09';
const RULES = [
  { weekday: 1, start: '10:00', end: '13:00' },
  { weekday: 1, start: '17:00', end: '20:00' },
];

let doctorId;
let owner;
let stranger;
let connection;

function at(date, time, who = owner) {
  return bookAppointment(connection, {
    doctorId,
    patientId: who,
    date,
    time,
    tz: TZ,
    current: fakeNow(date === MONDAY ? MONDAY : NEXT_MONDAY, '08:00'),
  });
}

test.before(() => {
  connection = db.get();
  doctorId = makeDoctor(connection, auth, { rules: RULES, slotMinutes: 30 });
  owner = makePatient(connection, auth, { name: 'Owner' });
  stranger = makePatient(connection, auth, { name: 'Stranger' });
});

test('cancelling 3 hours ahead works', () => {
  const appt = at(MONDAY, '17:00');
  const cancelled = cancelAppointment(connection, {
    id: appt.id,
    actor: { id: owner, role: 'patient' },
    tz: TZ,
    current: fakeNow(MONDAY, '14:00'),
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('cancelling inside the 2-hour guard is refused with a clear message', () => {
  const appt = at(MONDAY, '11:00');
  assert.throws(
    () => cancelAppointment(connection, {
      id: appt.id,
      actor: { id: owner, role: 'patient' },
      tz: TZ,
      current: fakeNow(MONDAY, '09:30'), // 90 minutes ahead
    }),
    (error) => error.status === 400 && /within 2 hours/iu.test(error.message),
  );
});

test('the guard boundary is exact: 120 minutes allowed, 119 refused', () => {
  const appt = at(MONDAY, '12:00');
  assert.equal(
    cancelAppointment(connection, {
      id: appt.id,
      actor: { id: owner, role: 'patient' },
      tz: TZ,
      current: fakeNow(MONDAY, '10:00'), // exactly 2h
    }).status,
    'cancelled',
  );

  const second = at(MONDAY, '19:00');
  assert.throws(
    () => cancelAppointment(connection, {
      id: second.id,
      actor: { id: owner, role: 'patient' },
      tz: TZ,
      current: fakeNow(MONDAY, '17:01'), // 1h59m
    }),
    (error) => error.status === 400,
  );
});

test('rescheduling is blocked by the same guard, then moves the appointment', () => {
  const appt = at(MONDAY, '17:30');
  assert.throws(
    () => rescheduleAppointment(connection, {
      id: appt.id,
      actor: { id: owner, role: 'patient' },
      date: NEXT_MONDAY,
      time: '10:00',
      tz: TZ,
      current: fakeNow(MONDAY, '16:30'),
    }),
    (error) => error.status === 400 && /no longer be cancelled or moved/iu.test(error.message),
  );

  const moved = rescheduleAppointment(connection, {
    id: appt.id,
    actor: { id: owner, role: 'patient' },
    date: NEXT_MONDAY,
    time: '10:00',
    tz: TZ,
    current: fakeNow(MONDAY, '12:00'),
  });
  assert.equal(moved.date, NEXT_MONDAY);
  assert.equal(moved.start_time, '10:00');
  assert.equal(moved.end_time, '10:30');

  // Monday 2 is free again, and the patient got told about the change.
  const mondayFree = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: fakeNow(MONDAY, '12:00') });
  assert.ok(mondayFree.slots.some((slot) => slot.start === '17:30'));
  const notes = connection.prepare("SELECT kind FROM notifications WHERE appointment_id = ? AND kind = 'rescheduled'").all(appt.id);
  assert.equal(notes.length, 1);
});

test('rescheduling onto a taken slot conflicts, and onto itself is refused', () => {
  const first = at(NEXT_MONDAY, '11:00');
  const second = at(NEXT_MONDAY, '11:30');
  assert.throws(
    () => rescheduleAppointment(connection, {
      id: second.id,
      actor: { id: owner, role: 'patient' },
      date: NEXT_MONDAY,
      time: '11:00',
      tz: TZ,
      current: fakeNow(NEXT_MONDAY, '08:00'),
    }),
    (error) => error.status === 409,
  );
  assert.equal(first.status, 'booked');
  assert.throws(
    () => rescheduleAppointment(connection, {
      id: first.id,
      actor: { id: owner, role: 'patient' },
      date: NEXT_MONDAY,
      time: '11:00',
      tz: TZ,
      current: fakeNow(NEXT_MONDAY, '08:00'),
    }),
    (error) => error.status === 400 && /different time/iu.test(error.message),
  );
});

test('a patient cannot touch someone else’s appointment', () => {
  const appt = at(MONDAY, '18:00');
  const other = { id: stranger, role: 'patient' };
  assert.throws(
    () => cancelAppointment(connection, { id: appt.id, actor: other, tz: TZ, current: fakeNow(MONDAY, '08:00') }),
    (error) => error.status === 403,
  );
  assert.throws(
    () => updateStatus(connection, { id: appt.id, actor: other, status: 'completed', tz: TZ, current: fakeNow(MONDAY, '19:00') }),
    (error) => error.status === 403,
  );
});

test('the doctor can close a visit once its time has arrived', () => {
  const appt = at(MONDAY, '18:30');
  assert.throws(
    () => updateStatus(connection, {
      id: appt.id,
      actor: { id: doctorId, role: 'doctor' },
      status: 'completed',
      tz: TZ,
      current: fakeNow(MONDAY, '18:00'), // still in the future
    }),
    (error) => error.status === 400 && /time has arrived/iu.test(error.message),
  );

  const done = updateStatus(connection, {
    id: appt.id,
    actor: { id: doctorId, role: 'doctor' },
    status: 'completed',
    tz: TZ,
    current: fakeNow(MONDAY, '19:15'),
  });
  assert.equal(done.status, 'completed');
  assert.throws(
    () => updateStatus(connection, {
      id: appt.id,
      actor: { id: doctorId, role: 'doctor' },
      status: 'no_show',
      tz: TZ,
      current: fakeNow(MONDAY, '19:20'),
    }),
    (error) => error.status === 400 && /already completed/iu.test(error.message),
  );
});

test('a doctor is not bound by the patient 2-hour guard', () => {
  const appt = at(MONDAY, '19:30');
  const cancelled = cancelAppointment(connection, {
    id: appt.id,
    actor: { id: doctorId, role: 'doctor' },
    tz: TZ,
    current: fakeNow(MONDAY, '19:00'), // 30 minutes ahead
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('marking a cancelled appointment is refused and status values are validated', () => {
  const appt = at(NEXT_MONDAY, '17:00');
  cancelAppointment(connection, { id: appt.id, actor: { id: owner, role: 'patient' }, tz: TZ, current: fakeNow(NEXT_MONDAY, '08:00') });
  assert.throws(
    () => updateStatus(connection, {
      id: appt.id,
      actor: { id: doctorId, role: 'doctor' },
      status: 'completed',
      tz: TZ,
      current: fakeNow(NEXT_MONDAY, '18:00'),
    }),
    (error) => error.status === 400 && /already cancelled/iu.test(error.message),
  );
  assert.throws(
    () => updateStatus(connection, {
      id: appt.id,
      actor: { id: doctorId, role: 'doctor' },
      status: 'did-not-turn-up',
      tz: TZ,
      current: fakeNow(NEXT_MONDAY, '18:00'),
    }),
    (error) => error.status === 400,
  );
});

test.after(() => db.close());
