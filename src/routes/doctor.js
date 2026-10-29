'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const clock = require('../clock');
const config = require('../config');
const v = require('../validate');
const { route } = require('../http');
const views = require('../views');
const appointments = require('../services/appointments');
const availability = require('../services/availability');
const slots = require('../services/slots');

module.exports = function router() {
  const r = express.Router();
  r.use(auth.requireRole('doctor'));

  const context = () => {
    const tz = config.load().timezone;
    return { tz, current: clock.now(tz) };
  };

  r.get(
    '/day',
    route((req, res) => {
      const { tz, current } = context();
      const date = req.query.date ? v.date(req.query.date) : current.date;
      const connection = db.get();
      const rows = appointments.listByDoctor(connection, req.user.id, date);
      const free = slots.freeSlots(connection, { doctorId: req.user.id, date, tz, current });
      res.json({
        date,
        today: current.date,
        appointments: rows.map((row) => views.appointmentView(row, { tz, current, actor: req.user })),
        free_slots: free.slots,
        closed: free.closed,
      });
    }),
  );

  r.get(
    '/overview',
    route((req, res) => {
      const { tz, current } = context();
      const connection = db.get();
      const todayRows = appointments.listByDoctor(connection, req.user.id, current.date);
      const upcomingRow = connection
        .prepare(
          `SELECT COUNT(*) AS count FROM appointments
            WHERE doctor_id = ? AND status = 'booked' AND (date > ? OR (date = ? AND start_time > ?))`,
        )
      .get(req.user.id, current.date, current.date, current.time);
      const stats = { total: todayRows.length, completed: 0, no_show: 0, booked: 0 };
      for (const row of todayRows) stats[row.status] = (stats[row.status] ?? 0) + 1;
      res.json({
        today: current.date,
        time: current.time,
        stats,
        upcoming_booked: upcomingRow.count,
        weekly: availability.getWeekly(connection, req.user.id),
        appointments: todayRows.map((row) => views.appointmentView(row, { tz, current, actor: req.user })),
      });
    }),
  );

  r.patch(
    '/appointments/:id/status',
    route((req, res) => {
      const { tz, current } = context();
      const status = v.oneOf(req.body?.status, 'Status', ['completed', 'no_show']);
      const updated = appointments.updateStatus(db.get(), {
        id: v.text(req.params.id, 'Appointment', { max: 60 }),
        actor: req.user,
        status,
        tz,
        current,
      });
      res.json({
        appointment: views.appointmentView(updated, { tz, current, actor: req.user }),
        message: `${updated.patient_name} marked ${status === 'no_show' ? 'no-show' : 'completed'}.`,
      });
    }),
  );

  r.get(
    '/availability',
    route((req, res) => {
      res.json({ weekly: availability.getWeekly(db.get(), req.user.id), day_names: availability.DAY_NAMES });
    }),
  );

  r.put(
    '/availability',
    route((req, res) => {
      const { weekly } = availability.setWeekly(db.get(), req.user.id, req.body ?? {});
      res.json({ weekly, message: 'Weekly availability saved.' });
    }),
  );

  r.get(
    '/blocked-days',
    route((req, res) => {
      res.json({ blocked_days: availability.listBlocked(db.get(), req.user.id) });
    }),
  );

  r.post(
    '/blocked-days',
    route((req, res) => {
      const blocked = availability.addBlocked(db.get(), req.user.id, {
        date: req.body?.date,
        reason: req.body?.reason,
      });
      res.status(201).json({ blocked_days: blocked, message: 'Day off blocked — those slots are now hidden.' });
    }),
  );

  r.delete(
    '/blocked-days/:date',
    route((req, res) => {
      const blocked = availability.removeBlocked(db.get(), req.user.id, req.params.date);
      res.json({ blocked_days: blocked, message: 'Day off removed.' });
    }),
  );

  return r;
};
