'use strict';
// The double-booking guarantee, tested the hard way: N threads, N SQLite
// connections, one slot.
process.env.DB_PATH = require('./helpers').freshDbPath('race');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const db = require('../src/db');
const auth = require('../src/auth');
const { freeSlots } = require('../src/services/slots');
const { fakeNow, makeDoctor, makePatient, TZ } = require('./helpers');

const MONDAY = '2026-11-02';
const SLOT = '11:00';
const RULES = [{ weekday: 1, start: '10:00', end: '13:00' }];

const dbPath = process.env.DB_PATH;
let doctorId;
let patients;
let connection;

/** Spawn `count` workers, release them together, collect their results. */
function race(count, time = SLOT) {
  const current = fakeNow(MONDAY, '09:00');
  return new Promise((resolve, reject) => {
    const workers = patients.slice(0, count).map((patientId, index) => {
      const worker = new Worker(path.join(__dirname, 'fixtures', 'booking-worker.js'), {
        workerData: {
          dbPath,
          doctorId,
          patientId,
          date: MONDAY,
          time,
          current,
          delayMs: index % 2, // two release waves, so they overlap
        },
      });
      return worker;
    });

    const results = [];
    let ready = 0;
    let done = 0;

    for (const worker of workers) {
      worker.on('message', (message) => {
        if (message === 'ready') {
          ready += 1;
          if (ready === workers.length) for (const peer of workers) peer.postMessage('go');
          return;
        }
        results.push(message);
        done += 1;
        if (done === workers.length) {
          for (const peer of workers) peer.unref();
          Promise.all(workers.map((peer) => peer.terminate())).then(() => resolve(results));
        }
      });
      worker.on('error', reject);
    }
  });
}

test.before(() => {
  connection = db.get();
  doctorId = makeDoctor(connection, auth, { rules: RULES, slotMinutes: 30 });
  patients = Array.from({ length: 8 }, () => makePatient(connection, auth, { name: `Racer ${Math.random()}` }));
});

test('8 simultaneous bookings of one slot: exactly one wins', async () => {
  const results = await race(8);
  const wins = results.filter((result) => result.ok);
  const losses = results.filter((result) => !result.ok);

  assert.equal(wins.length, 1, `expected one winner, got ${wins.length}`);
  assert.equal(losses.length, 7);
  for (const loss of losses) assert.equal(loss.status, 409, `expected 409, got ${loss.status}: ${loss.message}`);

  const rows = connection
    .prepare(`SELECT id, patient_id FROM appointments WHERE date = ? AND start_time = ? AND status = 'booked'`)
    .all(MONDAY, SLOT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].patient_id, wins[0].patient_id);
});

test('the losing patients can still book the neighbouring slots', async () => {
  const { slots } = freeSlots(connection, { doctorId, date: MONDAY, tz: TZ, current: fakeNow(MONDAY, '09:00') });
  assert.deepEqual(slots.map((slot) => slot.start), ['10:00', '10:30', '11:30', '12:00', '12:30']);
});

test('a second race on a different slot also produces one winner', async () => {
  const results = await race(5, '12:00');
  assert.equal(results.filter((result) => result.ok).length, 1);
  const rows = connection
    .prepare("SELECT id FROM appointments WHERE date = ? AND start_time = '12:00' AND status = 'booked'")
    .all(MONDAY);
  assert.equal(rows.length, 1);
});

test('the unique index is the backstop even if a check is bypassed', () => {
  const insert = connection.prepare(
    `INSERT INTO appointments (id, doctor_id, patient_id, date, start_time, end_time, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '10:00', '10:30', ?, ?, ?)`,
  );
  const stamp = new Date().toISOString();
  insert.run('apt_manual', doctorId, patients[0], MONDAY, 'booked', stamp, stamp);
  assert.throws(
    () => insert.run('apt_dup', doctorId, patients[1], MONDAY, 'booked', stamp, stamp),
    /UNIQUE constraint failed/iu,
  );
  // A cancelled booking on the same slot may coexist, because the index is partial.
  insert.run('apt_cancelled', doctorId, patients[2], MONDAY, 'cancelled', stamp, stamp);
  const count = connection
    .prepare("SELECT COUNT(*) AS n FROM appointments WHERE date = ? AND start_time = '10:00'")
    .get(MONDAY).n;
  assert.equal(count, 2);
});

test.after(() => db.close());
