'use strict';
// Runs in its own thread with its own SQLite connection, so several processes
// genuinely race for the same slot.
const { workerData, parentPort } = require('node:worker_threads');

process.env.DB_PATH = workerData.dbPath;
process.env.CLINIC_TIMEZONE = 'UTC';

const db = require('../../src/db');
const appointments = require('../../src/services/appointments');

parentPort.postMessage('ready');

parentPort.on('message', (message) => {
  if (message !== 'go') return;
  setTimeout(() => {
    let result;
    try {
      const created = appointments.bookAppointment(db.get(), {
        doctorId: workerData.doctorId,
        patientId: workerData.patientId,
        date: workerData.date,
        time: workerData.time,
        tz: 'UTC',
        current: workerData.current,
      });
      result = { ok: true, appointment_id: created.id, patient_id: created.patient_id };
    } catch (error) {
      result = { ok: false, status: error.status ?? 500, message: error.message };
    }
    parentPort.postMessage(result);
  }, workerData.delayMs ?? 0);
});
