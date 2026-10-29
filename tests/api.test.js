'use strict';
process.env.DB_PATH = require('./helpers').freshDbPath('api');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const auth = require('../src/auth');
const { startServer, makeDoctor, makePatient, allDayRules, DEMO_PASSWORD, TZ, clock } = require('./helpers');

const today = () => clock.now(TZ).date;
const plus = (n) => clock.addDays(today(), n);
const minus = (n) => clock.addDays(today(), -n);

let srv;
let doctorId;
let mondaysId;
let connection;

async function registerPatient(name, email) {
  const client = srv.client();
  const res = await client.post('/api/auth/register', { name, email, password: DEMO_PASSWORD });
  assert.equal(res.status, 201, res.text);
  return client;
}

test.before(async () => {
  connection = db.get();
  doctorId = makeDoctor(connection, auth, {
    name: 'Dr. All Day',
    email: 'allday@clinic.test',
    specialty: 'General Medicine',
    rules: allDayRules(),
    slotMinutes: 30,
    horizonDays: 30,
  });
  mondaysId = makeDoctor(connection, auth, {
    name: 'Dr. Mondays',
    email: 'mondays@clinic.test',
    specialty: 'Cardiology',
    rules: [{ weekday: 1, start: '09:00', end: '12:00' }],
    slotMinutes: 30,
    horizonDays: 30,
  });
  srv = await startServer();
});

test.after(async () => {
  await srv.close();
  db.close();
});

test('meta describes the clinic clock and rules', async () => {
  const res = await srv.client().get('/api/meta');
  assert.equal(res.status, 200);
  assert.equal(res.body.clinic_timezone, 'UTC');
  assert.equal(res.body.guard_minutes, 120);
  assert.match(res.body.clinic_date, /^\d{4}-\d{2}-\d{2}$/u);
});

test('unknown API endpoint returns JSON 404', async () => {
  const res = await srv.client().get('/api/nonsense');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Unknown API endpoint.');
});

test('patients must sign in before browsing doctors', async () => {
  const res = await srv.client().get('/api/doctors');
  assert.equal(res.status, 401);
  assert.match(res.body.error, /sign in/iu);
});

test('registration validates name, email and password on the server', async () => {
  const client = srv.client();
  const cases = [
    [{ name: '', email: 'ok@x.dev', password: 'clinic1234' }, /Full name is required/iu],
    [{ name: 'No Email', email: 'not-an-email', password: 'clinic1234' }, /valid email/iu],
    [{ name: 'Weak', email: 'weak@x.dev', password: 'short' }, /at least 8 characters/iu],
    [{ name: 'No Number', email: 'nn@x.dev', password: 'lettersonly' }, /one number/iu],
    [{ name: 'Bad Phone', email: 'bp@x.dev', password: 'clinic1234', phone: 'abc-def-000' }, /digits only/iu],
  ];
  for (const [body, pattern] of cases) {
    const res = await client.post('/api/auth/register', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
    assert.match(res.body.error, pattern);
  }
});

test('registration creates a patient session and rejects duplicate emails', async () => {
  const patient = await registerPatient('Zara Ali', 'zara@patient.test');
  const me = await patient.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'patient');
  assert.equal(me.body.user.name, 'Zara Ali');
  assert.ok(!JSON.stringify(me.body).includes('password_hash'), 'password hash must never leak');

  const dupe = await srv.client().post('/api/auth/register', { name: 'Copy', email: 'zara@patient.test', password: DEMO_PASSWORD });
  assert.equal(dupe.status, 409);
  assert.match(dupe.body.error, /already exists/iu);
});

test('login with a wrong password gives a generic error', async () => {
  const res = await srv.client().post('/api/auth/login', { email: 'zara@patient.test', password: 'wrongpass1' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Email or password is incorrect.');
});

test('doctor list shows weekly availability and the next open date', async () => {
  const patient = await registerPatient('List Viewer', 'list@patient.test');
  const res = await patient.get('/api/doctors');
  assert.equal(res.status, 200);
  const names = res.body.doctors.map((doctor) => doctor.name);
  assert.deepEqual(names.sort(), ['Dr. All Day', 'Dr. Mondays'].sort());
  const allDay = res.body.doctors.find((doctor) => doctor.name === 'Dr. All Day');
  assert.match(allDay.weekly, /Mon 00:00-23:30/u);
  assert.equal(allDay.slot_length_minutes, 30);
  assert.equal(allDay.next_open_date, today());
});

test('slot list never offers a slot that has already started', async () => {
  const patient = await registerPatient('Slot Checker', 'slots@patient.test');
  const res = await patient.get(`/api/doctors/${doctorId}/slots?date=${today()}`);
  assert.equal(res.status, 200);
  const nowMinutes = clock.now(TZ).minutes;
  assert.ok(res.body.slots.length > 0);
  for (const slot of res.body.slots) assert.ok(clock.toMinutes(slot.start) > nowMinutes, slot.start);
});

test('slot list rejects impossible dates', async () => {
  const patient = await registerPatient('Date Tester', 'dates@patient.test');
  const past = await patient.get(`/api/doctors/${doctorId}/slots?date=${minus(1)}`);
  assert.equal(past.status, 400);
  assert.match(past.body.error, /past/iu);

  const tooFar = await patient.get(`/api/doctors/${doctorId}/slots?date=${plus(31)}`);
  assert.equal(tooFar.status, 400);
  assert.match(tooFar.body.error, /30 days ahead/iu);

  const garbage = await patient.get(`/api/doctors/${doctorId}/slots?date=2026-02-30`);
  assert.equal(garbage.status, 400);
  assert.match(garbage.body.error, /real calendar date/iu);
});

test('a doctor that does not consult that weekday reports why', async () => {
  const patient = await registerPatient('Weekday Tester', 'weekday@patient.test');
  // Find the next Tuesday, which Dr. Mondays never works.
  let date = plus(1);
  while (clock.weekdayOf(date) !== 2) date = clock.addDays(date, 1);
  const res = await patient.get(`/api/doctors/${mondaysId}/slots?date=${date}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.slots, []);
  assert.equal(res.body.closed, 'no_availability');
  assert.match(res.body.message, /does not consult/iu);
});

test('booking validates the payload and then creates the appointment', async () => {
  const patient = await registerPatient('Booker One', 'booker1@patient.test');

  const badTime = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(2), time: '25:00' });
  assert.equal(badTime.status, 400);
  assert.match(badTime.body.error, /24-hour time/iu);

  const unknownDoctor = await patient.post('/api/appointments', { doctor_id: 'doc_missing', date: plus(2), time: '09:00' });
  assert.equal(unknownDoctor.status, 404);

  const misaligned = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(2), time: '09:07' });
  assert.equal(misaligned.status, 400);
  assert.match(misaligned.body.error, /not an open slot/iu);

  const ok = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(2), time: '09:00' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.appointment.start_time, '09:00');
  assert.equal(ok.body.appointment.end_time, '09:30');
  assert.equal(ok.body.appointment.status, 'booked');
  assert.ok(ok.body.appointment.can_cancel);

  const mine = await patient.get('/api/appointments/mine');
  assert.equal(mine.body.upcoming.length, 1);
  assert.equal(mine.body.upcoming[0].date, plus(2));

  const taken = await (await registerPatient('Booker Two', 'booker2@patient.test'))
    .post('/api/appointments', { doctor_id: doctorId, date: plus(2), time: '09:00' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /just been taken/iu);

  const stillFree = await patient.get(`/api/doctors/${doctorId}/slots?date=${plus(2)}`);
  assert.ok(!stillFree.body.slots.some((slot) => slot.start === '09:00'));
});

test('two patients firing at the same moment produce one booking', async () => {
  const a = await registerPatient('Racer A', 'race-a@patient.test');
  const b = await registerPatient('Racer B', 'race-b@patient.test');
  const body = { doctor_id: doctorId, date: plus(3), time: '10:00' };
  const [first, second] = await Promise.all([a.post('/api/appointments', body), b.post('/api/appointments', body)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  const rows = connection
    .prepare("SELECT id FROM appointments WHERE date = ? AND start_time = '10:00' AND status = 'booked'")
    .all(plus(3));
  assert.equal(rows.length, 1);
});

test('cancelling inside the 2-hour guard is refused by the API', async () => {
  const patient = await registerPatient('Guarded', 'guarded@patient.test');
  let date = today();
  let slots = (await patient.get(`/api/doctors/${doctorId}/slots?date=${date}`)).body.slots;
  if (slots.length === 0) {
    date = plus(1);
    slots = (await patient.get(`/api/doctors/${doctorId}/slots?date=${date}`)).body.slots;
  }
  const nearest = slots[0]; // 30-minute grid => always under 2 hours from now
  const booked = await patient.post('/api/appointments', { doctor_id: doctorId, date, time: nearest.start });
  assert.equal(booked.status, 201, booked.text);
  assert.equal(booked.body.appointment.can_cancel, false, 'server should already say this is not cancellable');

  const attempt = await patient.post(`/api/appointments/${booked.body.appointment.id}/cancel`, {});
  assert.equal(attempt.status, 400);
  assert.match(attempt.body.error, /within 2 hours/iu);

  const mine = await patient.get('/api/appointments/mine');
  assert.equal(mine.body.upcoming.length, 1, 'the appointment must still be booked');
});

test('a patient can cancel a far appointment and the slot opens again', async () => {
  const patient = await registerPatient('Canceller', 'cancel@patient.test');
  const booked = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(5), time: '11:00' });
  assert.equal(booked.status, 201);

  const cancelled = await patient.post(`/api/appointments/${booked.body.appointment.id}/cancel`, {});
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.appointment.status, 'cancelled');

  const again = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(5), time: '11:00' });
  assert.equal(again.status, 201, 'the freed slot must be bookable again');

  const rescheduleSame = await patient.post(`/api/appointments/${again.body.appointment.id}/reschedule`, {
    date: plus(5),
    time: '11:00',
  });
  assert.equal(rescheduleSame.status, 400);
  assert.match(rescheduleSame.body.error, /different time/iu);

  const moved = await patient.post(`/api/appointments/${again.body.appointment.id}/reschedule`, {
    date: plus(6),
    time: '14:00',
  });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.appointment.date, plus(6));

  const mine = await patient.get('/api/appointments/mine');
  assert.equal(mine.body.upcoming.length, 1);
  assert.equal(mine.body.past.length, 1);
});

test('patients cannot reach the doctor dashboard', async () => {
  const patient = await registerPatient('Nosy', 'nosy@patient.test');
  const res = await patient.get('/api/doctor/overview');
  assert.equal(res.status, 401);
  assert.match(res.body.error, /doctors/iu);
});

test('doctor dashboard lists the day in time order and closes visits', async () => {
  const patient = await registerPatient('Morning Patient', 'morning@patient.test');
  const pastBooking = await patient.post('/api/appointments', { doctor_id: doctorId, date: minus(1), time: '12:00' });
  assert.equal(pastBooking.status, 400);
  assert.match(pastBooking.body.error, /past/iu);

  // Yesterday's two visits exist in the DB already (history rows).
  const other = makePatient(connection, auth, { name: 'History Harry', email: 'harry@patient.test' });
  const stamp = new Date().toISOString();
  for (const [id, time] of [['apt_h1', '14:00'], ['apt_h2', '11:00']]) {
    connection
      .prepare(
        `INSERT INTO appointments (id, doctor_id, patient_id, date, start_time, end_time, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'booked', ?, ?)`,
      )
      .run(id, doctorId, other, minus(1), time, `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00`, stamp, stamp);
  }

  const doctor = srv.client();
  await doctor.login('allday@clinic.test');
  const day = await doctor.get(`/api/doctor/day?date=${minus(1)}`);
  assert.equal(day.status, 200);
  assert.deepEqual(day.body.appointments.map((row) => row.start_time), ['11:00', '14:00']);
  assert.equal(day.body.appointments[0].can_close, true);

  const done = await doctor.patch('/api/doctor/appointments/apt_h2/status', { status: 'completed' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.appointment.status, 'completed');

  const noshow = await doctor.patch('/api/doctor/appointments/apt_h1/status', { status: 'no_show' });
  assert.equal(noshow.body.appointment.status, 'no_show');

  const double = await doctor.patch('/api/doctor/appointments/apt_h1/status', { status: 'completed' });
  assert.equal(double.status, 400);
  assert.match(double.body.error, /already no show/iu);

  const overview = await doctor.get('/api/doctor/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.today, today());
  assert.equal(overview.body.weekly.slot_length_minutes, 30);
});

test('a doctor cannot change another doctor’s appointments', async () => {
  const other = srv.client();
  await other.login('mondays@clinic.test');
  const res = await other.patch('/api/doctor/appointments/apt_h2/status', { status: 'completed' });
  assert.equal(res.status, 403);
});

test('availability updates are validated then applied', async () => {
  const doctor = srv.client();
  await doctor.login('mondays@clinic.test');

  const badLength = await doctor.put('/api/doctor/availability', {
    slot_length_minutes: 20,
    rules: [{ weekday: 1, start_time: '09:00', end_time: '12:00' }],
  });
  assert.equal(badLength.status, 400);
  assert.match(badLength.body.error, /15 or 30/iu);

  const overlapping = await doctor.put('/api/doctor/availability', {
    slot_length_minutes: 30,
    rules: [
      { weekday: 1, start_time: '09:00', end_time: '12:00' },
      { weekday: 1, start_time: '11:30', end_time: '14:00' },
    ],
  });
  assert.equal(overlapping.status, 400);
  assert.match(overlapping.body.error, /overlapping/iu);

  const tooShort = await doctor.put('/api/doctor/availability', {
    slot_length_minutes: 30,
    rules: [{ weekday: 1, start_time: '09:00', end_time: '09:20' }],
  });
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.body.error, /shorter than the 30-minute/iu);

  const saved = await doctor.put('/api/doctor/availability', {
    slot_length_minutes: 15,
    rules: [
      { weekday: 1, start_time: '10:00', end_time: '11:00' },
      { weekday: 3, start_time: '16:00', end_time: '17:00' },
    ],
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.weekly.slot_length_minutes, 15);
  assert.equal(saved.body.weekly.rules.length, 2);

  let wednesday = plus(1);
  while (clock.weekdayOf(wednesday) !== 3) wednesday = clock.addDays(wednesday, 1);
  const patient = await registerPatient('New Slots', 'newslots@patient.test');
  const slots = await patient.get(`/api/doctors/${mondaysId}/slots?date=${wednesday}`);
  assert.deepEqual(slots.body.slots.map((slot) => slot.start), ['16:00', '16:15', '16:30', '16:45']);
});

test('a blocked day hides slots for patients and can be undone', async () => {
  const doctor = srv.client();
  await doctor.login('allday@clinic.test');
  const patient = await registerPatient('Leave Watcher', 'leave@patient.test');

  const before = await patient.get(`/api/doctors/${doctorId}/slots?date=${plus(4)}`);
  assert.ok(before.body.slots.length > 0);

  const blocked = await doctor.post('/api/doctor/blocked-days', { date: plus(4), reason: 'Conference' });
  assert.equal(blocked.status, 201, blocked.text);
  assert.deepEqual(blocked.body.blocked_days.map((row) => row.date), [plus(4)]);

  const after = await patient.get(`/api/doctors/${doctorId}/slots?date=${plus(4)}`);
  assert.deepEqual(after.body.slots, []);
  assert.equal(after.body.closed, 'blocked');
  assert.match(after.body.message, /on leave/iu);

  const attempt = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(4), time: '09:00' });
  assert.equal(attempt.status, 400);
  assert.match(attempt.body.error, /on leave/iu);

  const removed = await doctor.del(`/api/doctor/blocked-days/${plus(4)}`);
  assert.equal(removed.status, 200);
  const reopened = await patient.get(`/api/doctors/${doctorId}/slots?date=${plus(4)}`);
  assert.ok(reopened.body.slots.length > 0);
});

test('in-app notifications confirm the booking', async () => {
  const patient = await registerPatient('Notified Nadia', 'nadia@patient.test');
  const booked = await patient.post('/api/appointments', { doctor_id: doctorId, date: plus(8), time: '09:00' });
  assert.equal(booked.status, 201);

  const notes = await patient.get('/api/notifications');
  assert.equal(notes.status, 200);
  const confirm = notes.body.notifications.find((note) => note.kind === 'booking_confirmed');
  assert.ok(confirm, 'booking must create a confirmation notification');
  assert.match(confirm.message, /Appointment confirmed/u);
  assert.ok(notes.body.unread >= 1);

  await patient.post('/api/notifications/read', { all: true });
  const after = await patient.get('/api/notifications');
  assert.equal(after.body.unread, 0);
});

test('invalid JSON and oversized bodies get clean errors', async () => {
  const client = srv.client();
  const broken = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":',
  });
  assert.equal(broken.status, 400);
  assert.match((await broken.json()).error, /valid JSON/iu);
  await client.get('/api/meta');
});

test('logging out destroys the session', async () => {
  const patient = await registerPatient('Leaver', 'leaver@patient.test');
  const out = await patient.post('/api/auth/logout', {});
  assert.equal(out.status, 200);
  const me = await patient.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user, null);
  const doctors = await patient.get('/api/doctors');
  assert.equal(doctors.status, 401);
});
