'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const clock = require('../clock');
const v = require('../validate');
const config = require('../config');
const { route } = require('../http');
const { NotFoundError } = require('../errors');
const slots = require('../services/slots');
const { doctorLabel } = require('../names');

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weeklyLabel(rules) {
  const byDay = new Map();
  for (const rule of rules) {
    const list = byDay.get(rule.weekday) ?? [];
    list.push(`${rule.start_time}-${rule.end_time}`);
    byDay.set(rule.weekday, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekday, windows]) => `${DAY_SHORT[weekday]} ${windows.join(', ')}`)
    .join(' · ');
}

function rulesByDoctor(connection, ids) {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = connection
    .prepare(`SELECT doctor_id, weekday, start_time, end_time FROM availability_rules WHERE doctor_id IN (${placeholders})`)
    .all(...ids);
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.doctor_id) ?? [];
    list.push(row);
    map.set(row.doctor_id, list);
  }
  return map;
}

/** First date (within the doctor's horizon) that still has a free slot. */
function nextOpenDate(connection, doctorId, horizonDays, tz, current) {
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const date = clock.addDays(current.date, offset);
    const { slots: free } = slots.freeSlots(connection, { doctorId, date, tz, current });
    if (free.length > 0) return { date, free_count: free.length };
  }
  return null;
}

module.exports = function router() {
  const r = express.Router();
  const tz = () => config.load().timezone;

  r.get(
    '/',
    auth.requireUser,
    route((req, res) => {
      const connection = db.get();
      const current = clock.now(tz());
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      const specialty = typeof req.query.specialty === 'string' ? req.query.specialty.trim() : '';

      let rows = connection
        .prepare(
          `SELECT u.id, u.name, p.specialty, p.bio, p.consultation_fee_cents, p.slot_length_minutes, p.horizon_days
             FROM users u JOIN doctor_profiles p ON p.user_id = u.id
            WHERE u.role = 'doctor' ORDER BY u.name`,
        )
        .all();

      if (specialty) rows = rows.filter((row) => row.specialty.toLowerCase() === specialty.toLowerCase());
      if (q) {
        rows = rows.filter((row) => `${row.name} ${row.specialty} ${row.bio}`.toLowerCase().includes(q));
      }

      const rules = rulesByDoctor(connection, rows.map((row) => row.id));
      res.json({
        today: current.date,
        doctors: rows.map((row) => {
          const open = nextOpenDate(connection, row.id, row.horizon_days, tz(), current);
          return {
            ...row,
            weekly: weeklyLabel(rules.get(row.id) ?? []),
            next_open_date: open?.date ?? null,
            next_open_free_slots: open?.free_count ?? 0,
          };
        }),
      });
    }),
  );

  r.get(
    '/specialties',
    auth.requireUser,
    route((req, res) => {
      const rows = db.get().prepare("SELECT DISTINCT p.specialty FROM doctor_profiles p JOIN users u ON u.id = p.user_id WHERE u.role = 'doctor' ORDER BY p.specialty").all();
      res.json({ specialties: rows.map((row) => row.specialty) });
    }),
  );

  r.get(
    '/:id',
    auth.requireUser,
    route((req, res) => {
      const connection = db.get();
      const doctor = slots.doctorContext(connection, req.params.id);
      if (!doctor) throw NotFoundError('Doctor not found.');
      const current = clock.now(tz());
      const rules = slots.rulesFor(connection, doctor.id);
      res.json({
        doctor,
        today: current.date,
        weekly: weeklyLabel(rules),
        rules: rules.map((rule) => ({ weekday: rule.weekday, day: DAY_SHORT[rule.weekday], start_time: rule.start_time, end_time: rule.end_time })),
        open_weekdays: [...new Set(rules.map((rule) => rule.weekday))].sort(),
        blocked_days: connection
          .prepare('SELECT date, reason FROM blocked_days WHERE doctor_id = ? AND date >= ? ORDER BY date')
          .all(doctor.id, current.date),
      });
    }),
  );

  r.get(
    '/:id/slots',
    auth.requireUser,
    route((req, res) => {
      const connection = db.get();
      const doctor = slots.doctorContext(connection, req.params.id);
      if (!doctor) throw NotFoundError('Doctor not found.');
      const date = v.dateInHorizon(req.query.date, { maxAheadDays: doctor.horizon_days, tz: tz() });
      const result = slots.freeSlots(connection, { doctorId: doctor.id, date, tz: tz() });
      res.json({
        doctor_id: doctor.id,
        date,
        slot_length_minutes: doctor.slot_length_minutes,
        closed: result.closed,
        message: closedMessage(result.closed, doctor, date),
        slots: result.slots.map((slot) => ({ start: slot.start, end: slot.end })),
      });
    }),
  );

  return r;
};

const CLOSED_MESSAGES = {
  past: 'That date has already passed.',
  blocked: 'The doctor is on leave that day, so no slots are open.',
  no_availability: 'The doctor does not consult on that weekday.',
  fully_past: 'All of today’s slots have already started — try a later date.',
  fully_booked: 'Every slot on this date is booked. Try another date.',
  unknown_doctor: 'Doctor not found.',
};

function closedMessage(closed, doctor, date) {
  if (!closed) return null;
  return CLOSED_MESSAGES[closed] ?? `No free slots for Dr. ${doctor.name} on ${date}.`;
}
