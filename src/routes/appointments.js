'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const clock = require('../clock');
const config = require('../config');
const v = require('../validate');
const { route } = require('../http');
const views = require('../views');
const { doctorLabel } = require('../names');
const { NotFoundError } = require('../errors');
const appointments = require('../services/appointments');

module.exports = function router() {
  const r = express.Router();
  const patientOnly = auth.requireRole('patient');

  r.post('/', patientOnly, route((req, res) => {
    const connection = db.get();
    const tz = config.load().timezone;
    const current = clock.now(tz);
    const doctorId = v.text(req.body?.doctor_id, 'Doctor', { max: 60 });
    const doctor = connection
      .prepare("SELECT p.horizon_days, u.name FROM doctor_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.role = 'doctor'")
      .get(doctorId);
    if (!doctor) throw NotFoundError('Doctor not found.');
    const date = v.dateInHorizon(req.body?.date, { maxAheadDays: doctor.horizon_days, tz });
    const time = v.time(req.body?.time, 'Slot time');

    const created = appointments.bookAppointment(connection, {
      doctorId,
      patientId: req.user.id,
      date,
      time,
      tz,
      current,
    });
    res.status(201).json({
      appointment: views.appointmentView(created, { tz, current, actor: req.user }),
      message: `Booked with ${doctorLabel(created.doctor_name)} on ${created.date} at ${created.start_time}.`,
    });
  }));

  r.get('/mine', patientOnly, route((req, res) => {
    const connection = db.get();
    const tz = config.load().timezone;
    const current = clock.now(tz);
    const rows = connection
      .prepare(
        `SELECT a.*, u.name AS doctor_name, p.specialty, p.consultation_fee_cents, p.slot_length_minutes
           FROM appointments a
           JOIN users u ON u.id = a.doctor_id
           JOIN doctor_profiles p ON p.user_id = a.doctor_id
          WHERE a.patient_id = ?`,
      )
      .all(req.user.id);
    res.json(views.groupAppointments(rows, { tz, current, actor: req.user }));
  }));

  r.post('/:id/cancel', patientOnly, route((req, res) => {
    const connection = db.get();
    const tz = config.load().timezone;
    const current = clock.now(tz);
    const cancelled = appointments.cancelAppointment(connection, {
      id: v.text(req.params.id, 'Appointment', { max: 60 }),
      actor: req.user,
      tz,
      current,
    });
    res.json({
      appointment: views.appointmentView(cancelled, { tz, current, actor: req.user }),
      message: `Appointment on ${cancelled.date} at ${cancelled.start_time} cancelled. The slot is free again.`,
    });
  }));

  r.post('/:id/reschedule', patientOnly, route((req, res) => {
    const connection = db.get();
    const tz = config.load().timezone;
    const current = clock.now(tz);
    const id = v.text(req.params.id, 'Appointment', { max: 60 });
    const existing = appointments.findAppointment(connection, id);
    if (!existing) throw NotFoundError('Appointment not found.');
    const date = v.dateInHorizon(req.body?.date, { maxAheadDays: existing.horizon_days ?? 180, tz });
    const time = v.time(req.body?.time, 'Slot time');

    const moved = appointments.rescheduleAppointment(connection, {
      id,
      actor: req.user,
      date,
      time,
      tz,
      current,
    });
    res.json({
      appointment: views.appointmentView(moved, { tz, current, actor: req.user }),
      message: `Moved to ${moved.date} at ${moved.start_time}.`,
    });
  }));

  return r;
};
