'use strict';
require('../src/loadEnv').loadEnv();
const crypto = require('node:crypto');
const db = require('../src/db');
const clock = require('../src/clock');
const config = require('../src/config');
const auth = require('../src/auth');
const slots = require('../src/services/slots');
const appointments = require('../src/services/appointments');

const TZ = config.load().timezone;
const PASSWORD = process.env.SEED_PASSWORD || 'clinic1234';

const MON_FRI = [1, 2, 3, 4, 5];
const DOCTORS = [
  {
    name: 'Dr. Ayesha Khan',
    email: 'ayesha.khan@clinic.dev',
    specialty: 'Cardiology',
    bio: 'Chest pain follow-up, hypertension and ECG review. 12 years in tertiary care.',
    fee_cents: 250000,
    slot_length_minutes: 30,
    horizon_days: 45,
    rules: [
      ...[1, 3, 5].flatMap((weekday) => [
        { weekday, start: '10:00', end: '13:00' },
        { weekday, start: '17:00', end: '20:00' },
      ]),
      { weekday: 6, start: '09:00', end: '12:00' },
    ],
  },
  {
    name: 'Dr. Bilal Ahmed',
    email: 'bilal.ahmed@clinic.dev',
    specialty: 'Dermatology',
    bio: 'Acne, eczema and skin lesion checks. Short follow-up reviews available.',
    fee_cents: 180000,
    slot_length_minutes: 15,
    horizon_days: 30,
    rules: [
      { weekday: 2, start: '09:00', end: '12:30' },
      { weekday: 4, start: '09:00', end: '12:30' },
      { weekday: 6, start: '16:00', end: '19:00' },
    ],
  },
  {
    name: 'Dr. Sana Mirza',
    email: 'sana.mirza@clinic.dev',
    specialty: 'Pediatrics',
    bio: 'Newborn care, vaccination schedule and childhood fever clinics.',
    fee_cents: 200000,
    slot_length_minutes: 30,
    horizon_days: 60,
    rules: MON_FRI.map((weekday) => ({ weekday, start: '11:00', end: '14:00' })),
  },
  {
    name: 'Dr. Usman Tariq',
    email: 'usman.tariq@clinic.dev',
    specialty: 'General Medicine',
    bio: 'Everyday illnesses, lab report review and chronic disease follow-up.',
    fee_cents: 120000,
    slot_length_minutes: 15,
    horizon_days: 21,
    rules: [
      ...MON_FRI.map((weekday) => ({ weekday, start: '09:00', end: '11:00' })),
      ...[1, 2, 4].map((weekday) => ({ weekday, start: '17:00', end: '19:30' })),
    ],
  },
];

const PATIENTS = [
  { name: 'Ali Raza', email: 'ali.raza@patient.dev', phone: '+92 300 1112233' },
  { name: 'Hina Fatima', email: 'hina.fatima@patient.dev', phone: '+92 301 4445566' },
  { name: 'John Doe', email: 'john.doe@patient.dev', phone: '+92 333 7778899' },
  { name: 'Maryam Siddiqui', email: 'maryam.siddiqui@patient.dev', phone: '+92 345 1213141' },
];

function insertUser(connection, { id, role, name, email, phone }) {
  connection
    .prepare('INSERT INTO users (id, role, name, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, role, name, email, phone ?? null, auth.hashPassword(PASSWORD), new Date().toISOString());
  return id;
}

/** First future slot for a doctor at or after `offsetDays`, skipping taken ones. */
function firstFreeSlot(connection, doctorId, offsetDays = 1) {
  const current = clock.now(TZ);
  const doctor = slots.doctorContext(connection, doctorId);
  for (let i = offsetDays; i <= doctor.horizon_days; i += 1) {
    const date = clock.addDays(current.date, i);
    const { slots: free } = slots.freeSlots(connection, { doctorId, date, tz: TZ, current });
    if (free.length) return { date, time: free[0].start };
  }
  return null;
}

function nthFreeSlot(connection, doctorId, offsetDays, index) {
  const current = clock.now(TZ);
  const date = clock.addDays(current.date, offsetDays);
  const { slots: free } = slots.freeSlots(connection, { doctorId, date, tz: TZ, current });
  return free[index] ? { date, time: free[index].start } : null;
}

/**
 * Free slots on `current.date`, already-started ones first so the doctor has
 * Complete / No-show actions to try, then the next upcoming ones for mornings
 * when the clinic has not opened yet.
 */
function todaySlots(connection, doctor, current, count) {
  const weekday = clock.weekdayOf(current.date);
  const taken = new Set(slots.bookedStarts(connection, doctor.id, current.date));
  const started = [];
  for (const rule of slots.rulesFor(connection, doctor.id)) {
    if (Number(rule.weekday) !== weekday) continue;
    const from = clock.toMinutes(rule.start_time);
    const to = clock.toMinutes(rule.end_time);
    for (let t = from; t + doctor.slot_length_minutes <= to; t += doctor.slot_length_minutes) {
      if (t <= current.minutes - 5) started.push(clock.toTime(t));
    }
  }
  started.sort((a, b) => clock.toMinutes(b) - clock.toMinutes(a));
  const { slots: upcoming } = slots.freeSlots(connection, { doctorId: doctor.id, date: current.date, tz: TZ, current });
  const ordered = [...started, ...upcoming.map((slot) => slot.start)].filter((time) => !taken.has(time));
  return [...new Set(ordered)].slice(0, count);
}

/** Direct insert for history rows (past dates are not bookable through the API). */
function insertPastAppointment(connection, { doctorId, patientId, date, time, length, status }) {
  const start = clock.toMinutes(time);
  connection
    .prepare(
      `INSERT INTO appointments (id, doctor_id, patient_id, date, start_time, end_time, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `apt_${crypto.randomUUID().slice(0, 12)}`,
      doctorId,
      patientId,
      date,
      time,
      clock.toTime(start + length),
      status,
      new Date(clock.toInstant(TZ, date, time) - 3 * 86400000).toISOString(),
      new Date().toISOString(),
    );
}

function seed() {
  const connection = db.open();
  connection.exec('PRAGMA foreign_keys = OFF;');
  for (const table of ['notifications', 'appointments', 'blocked_days', 'availability_rules', 'doctor_profiles', 'sessions', 'users']) {
    connection.exec(`DELETE FROM ${table}; DELETE FROM sqlite_sequence WHERE name = '${table}';`);
  }
  connection.exec('PRAGMA foreign_keys = ON;');

  const doctors = DOCTORS.map((doctor) => {
    const id = insertUser(connection, { id: auth.newId('doc'), role: 'doctor', name: doctor.name, email: doctor.email });
    connection
      .prepare(
        `INSERT INTO doctor_profiles (user_id, specialty, bio, consultation_fee_cents, slot_length_minutes, horizon_days)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, doctor.specialty, doctor.bio, doctor.fee_cents, doctor.slot_length_minutes, doctor.horizon_days);
    const insertRule = connection.prepare(
      'INSERT INTO availability_rules (doctor_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)',
    );
    for (const rule of doctor.rules) insertRule.run(id, rule.weekday, rule.start, rule.end);
    return { ...doctor, id };
  });

  const patients = PATIENTS.map((patient) => ({
    ...patient,
    id: insertUser(connection, { id: auth.newId('pat'), role: 'patient', ...patient }),
  }));

  // One doctor takes a day off next week (demo of the leave/blocked-day feature).
  const leaveDate = clock.addDays(clock.now(TZ).date, 7);
  connection
    .prepare('INSERT OR IGNORE INTO blocked_days (doctor_id, date, reason) VALUES (?, ?, ?)')
    .run(doctors[2].id, leaveDate, 'Conference in Lahore');

  const booked = [];
  const plan = [
    { doctor: doctors[0], patient: patients[0], offset: 1, index: 1 },
    { doctor: doctors[0], patient: patients[1], offset: 1, index: 3 },
    { doctor: doctors[1], patient: patients[2], offset: 2, index: 0 },
    { doctor: doctors[3], patient: patients[0], offset: 2, index: 2 },
    { doctor: doctors[3], patient: patients[3], offset: 3, index: 0 },
  ];
  for (const item of plan) {
    const slot = nthFreeSlot(connection, item.doctor.id, item.offset, item.index) ?? firstFreeSlot(connection, item.doctor.id, item.offset);
    if (!slot) continue;
    booked.push(
      appointments.bookAppointment(connection, {
        doctorId: item.doctor.id,
        patientId: item.patient.id,
        date: slot.date,
        time: slot.time,
        tz: TZ,
      }),
    );
  }

  // History so both dashboards have something in "past".
  const current = clock.now(TZ);
  const history = [
    { doctor: doctors[0], patient: patients[0], offset: -3, time: '11:00', status: 'completed' },
    { doctor: doctors[2], patient: patients[0], offset: -2, time: '12:00', status: 'completed' },
    { doctor: doctors[1], patient: patients[1], offset: -6, time: '10:15', status: 'no_show' },
    { doctor: doctors[3], patient: patients[3], offset: -1, time: '09:30', status: 'cancelled' },
    { doctor: doctors[2], patient: patients[2], offset: -9, time: '13:00', status: 'completed' },
  ];
  for (const item of history) {
    insertPastAppointment(connection, {
      doctorId: item.doctor.id,
      patientId: item.patient.id,
      date: clock.addDays(current.date, item.offset),
      time: item.time,
      length: item.doctor.slot_length_minutes,
      status: item.status,
    });
  }

  // Visits on today's date, so the doctor dashboard always has something to work through.
  const pendingPlan = [
    { doctor: doctors[0], patient: patients[1] },
    { doctor: doctors[0], patient: patients[2] },
    { doctor: doctors[1], patient: patients[3] },
    { doctor: doctors[1], patient: patients[0] },
    { doctor: doctors[2], patient: patients[2] },
    { doctor: doctors[3], patient: patients[1] },
    { doctor: doctors[3], patient: patients[2] },
  ];
  let pending = 0;
  for (const item of pendingPlan) {
    const [time] = todaySlots(connection, item.doctor, current, 1);
    if (!time) continue;
    insertPastAppointment(connection, {
      doctorId: item.doctor.id,
      patientId: item.patient.id,
      date: current.date,
      time,
      length: item.doctor.slot_length_minutes,
      status: 'booked',
    });
    pending += 1;
  }
  if (pending === 0) console.log('Note: no doctor consults today, so the dashboards start empty.');

  // Seed the notification bell; the real reminder is generated 1h before by syncReminders().
  if (booked[0]) {
    connection
      .prepare(
        `INSERT OR IGNORE INTO notifications (user_id, appointment_id, kind, message, dedupe_key, created_at)
         VALUES (?, ?, 'welcome', ?, ?, ?)`,
      )
      .run(
        booked[0].patient_id,
        booked[0].id,
        `Your appointment with ${booked[0].doctor_name} on ${booked[0].date} at ${booked[0].start_time} is confirmed. Arrive 10 minutes early.`,
        `welcome:${booked[0].id}`,
        new Date().toISOString(),
      );
  }

  const counts = {
    users: connection.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    doctors: connection.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'doctor'").get().n,
    patients: connection.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'patient'").get().n,
    rules: connection.prepare('SELECT COUNT(*) AS n FROM availability_rules').get().n,
    appointments: connection.prepare('SELECT COUNT(*) AS n FROM appointments').get().n,
  };

  console.log('Seeded clinic demo data:', counts);
  console.log(`\nDemo password for every account: ${PASSWORD}`);
  console.log('\nDoctors');
  for (const doctor of doctors) console.log(`  ${doctor.email.padEnd(26)} ${doctor.name} — ${doctor.specialty}`);
  console.log('\nPatients');
  for (const patient of patients) console.log(`  ${patient.email.padEnd(26)} ${patient.name}`);
  console.log(`\nTimezone: ${TZ}  (today in the clinic: ${current.date} ${current.time})`);
  console.log(`Day off seeded for ${doctors[2].name}: ${leaveDate}`);
  db.close();
}

seed();
