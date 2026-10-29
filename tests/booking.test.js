'use strict';
process.env.DB_PATH = require('./helpers').freshDbPath('booking');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const auth = require('../src/auth');
const { bookAppointment, cancelAppointment, findAppointment, resolveSlot } = require('../src/services/appointments');
const { freeSlots } = require('../src/services/slots');
const availability = require('../src/services/availability');
const { fakeNow, makeDoctor, makePatient, TZ, clock } = require('./helpers');

// Monday 2026-11-02: 10:00-13:00 and 17:00-20:00, 30-minute slots.
const MONDAY = '2026-11-02';
const NOW = fakeNow(MONDAY, '09:00');
const RULES = [
  { weekday: 1, start: '10:00', end: '13:00' },
  { weekday: 1, start: '17:00', end: '20:00' },
];

let doctorId;
let patientId;
let otherPatient;
let connection;

function book(date, time, who = patientId) {
  return bookAppointment(connection, { doctorId, patientId: who, date, time, tz: TZ, current: NOW });
}

test.before(() => {
  connection = db.get();
  doctorId = makeDoctor(connection, auth, { rules: RULES, slotMinutes: 30, horizonDays: 30 });
  patientId = makePatient(connection, auth, { name: 'Ali' });
  otherPatient = makePatient(connection, auth, { name: 'Bea' });
});

test('free slots come from availability when the day is empty', () => {
  const { slots } = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: NOW });
  assert.equal(slots.length, 12); // 6 morning + 6 evening
  assert.equal(slots[0].start, '10:00');
  assert.equal(slots.at(-1).start, '19:30');
});

test('booking stores the slot with a computed end time and a confirmation', () => {
  const created = book(MONDAY, '10:00');
  assert.equal(created.status, 'booked');
  assert.equal(created.start_time, '10:00');
  assert.equal(created.end_time, '10:30');
  assert.equal(created.patient_id, patientId);
  const note = connection.prepare('SELECT message FROM notifications WHERE appointment_id = ?').get(created.id);
  assert.match(note.message, /Appointment confirmed/);
});

test('a booked slot disappears from the free list', () => {
  const { slots } = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: NOW });
  assert.equal(slots.length, 11);
  assert.ok(!slots.some((slot) => slot.start === '10:00'));
});

test('the same slot cannot be booked twice', () => {
  assert.throws(() => book(MONDAY, '10:00', otherPatient), (error) => error.status === 409);
  const rows = connection.prepare("SELECT id FROM appointments WHERE date = ? AND start_time = '10:00'").all(MONDAY);
  assert.equal(rows.length, 1);
});

test('a different patient can still book another slot of the same doctor', () => {
  const second = book(MONDAY, '10:30', otherPatient);
  assert.equal(second.start_time, '10:30');
  assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'booked'").get().n, 2);
});

test('booking outside the availability window is rejected', () => {
  assert.throws(() => book(MONDAY, '14:00'), (error) => error.status === 400);
  assert.throws(() => book(MONDAY, '10:10'), (error) => error.status === 400); // not aligned to a slot
});

test('booking on a day the doctor does not consult is rejected', () => {
  assert.throws(() => book('2026-11-04', '10:00'), (error) => /does not consult/iu.test(error.message));
});

test('booking a slot that has already started is rejected', () => {
  assert.throws(() => book(MONDAY, '09:30'), (error) => error.status === 400);
  assert.throws(() => book('2026-11-01', '10:00'), (error) => /past/iu.test(error.message));
});

test('booking beyond the doctor’s horizon is rejected', () => {
  const farDate = clock.addDays(MONDAY, 31);
  assert.throws(
    () => bookAppointment(connection, { doctorId, patientId, date: farDate, time: '10:00', tz: TZ, current: NOW }),
    (error) => /days ahead/iu.test(error.message),
  );
});

test('a blocked (leave) day hides its slots and refuses bookings', () => {
  availability.addBlocked(connection, doctorId, { date: MONDAY, reason: 'Leave', tz: TZ });
  const { slots, closed } = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: NOW });
  assert.deepEqual(slots, []);
  assert.equal(closed, 'blocked');
  assert.throws(
    () => bookAppointment(connection, { doctorId, patientId: otherPatient, date: MONDAY, time: '11:00', tz: TZ, current: NOW }),
    (error) => /on leave/iu.test(error.message),
  );
  availability.removeBlocked(connection, doctorId, MONDAY);
  const after = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: NOW });
  assert.ok(after.slots.some((slot) => slot.start === '11:00'));
});

test('cancelling frees the slot for someone else', () => {
  const created = book(MONDAY, '17:00');
  cancelAppointment(connection, { id: created.id, actor: { id: patientId, role: 'patient' }, tz: TZ, current: NOW });
  assert.equal(findAppointment(connection, created.id).status, 'cancelled');
  const { slots } = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: NOW });
  assert.ok(slots.some((slot) => slot.start === '17:00'));
  const replacement = book(MONDAY, '17:00', otherPatient);
  assert.equal(replacement.patient_id, otherPatient);
});

test('resolveSlot ignores the appointment being rescheduled', () => {
  const created = book('2026-11-09', '10:00');
  const own = resolveSlot(connection, {
    doctorId,
    date: '2026-11-09',
    time: '10:00',
    tz: TZ,
    current: fakeNow('2026-11-09', '08:00'),
    ignoreAppointmentId: created.id,
  });
  assert.equal(own.slot.start, '10:00');
  assert.throws(
    () => resolveSlot(connection, { doctorId, date: '2026-11-09', time: '10:00', tz: TZ, current: fakeNow('2026-11-09', '08:00') }),
    (error) => error.status === 409,
  );
});

test('a fully booked day reports fully_booked', () => {
  const day = '2026-11-16';
  const connection2 = connection;
  for (const time of ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30']) {
    const patient = makePatient(connection2, auth, { name: `P ${time}` });
    bookAppointment(connection2, { doctorId, patientId: patient, date: day, time, tz: TZ, current: fakeNow(day, '08:00') });
  }
  const { slots, closed } = freeSlots(connection2, { doctorId, date: day, tz: TZ, current: fakeNow(day, '08:00') });
  assert.deepEqual(slots, []);
  assert.equal(closed, 'fully_booked');
});

test.after(() => db.close());
