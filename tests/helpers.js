'use strict';
// Tests pin the clinic timezone so wall-clock maths are predictable.
process.env.CLINIC_TIMEZONE = process.env.TEST_TIMEZONE || 'UTC';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const clock = require('../src/clock');

const TZ = 'UTC';
const DEMO_PASSWORD = 'clinic1234';

function freshDbPath(name = 'clinic') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `clinic-${name}-`)), 'test.db');
}

/** A fake "now" the services accept, so tests do not depend on wall-clock time. */
function fakeNow(date, time) {
  return {
    instant: clock.toInstant(TZ, date, time),
    date,
    time,
    minutes: clock.toMinutes(time),
    weekday: clock.weekdayOf(date),
  };
}

function insertUser(db, auth, { id, role, name, email, phone = null }) {
  db.prepare(
    'INSERT INTO users (id, role, name, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, role, name, email, phone, auth.hashPassword(DEMO_PASSWORD), new Date().toISOString());
  return id;
}

/**
 * Create a doctor with weekly windows, e.g.
 * makeDoctor(db, auth, { rules: [{ weekday: 1, start: '10:00', end: '13:00' }] })
 */
function makeDoctor(db, auth, options = {}) {
  const id = options.id ?? auth.newId('doc');
  insertUser(db, auth, {
    id,
    role: 'doctor',
    name: options.name ?? 'Dr. Test',
    email: options.email ?? `${id}@clinic.test`,
  });
  db.prepare(
    `INSERT INTO doctor_profiles (user_id, specialty, bio, consultation_fee_cents, slot_length_minutes, horizon_days)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, options.specialty ?? 'Testology', options.bio ?? '', options.feeCents ?? 100000, options.slotMinutes ?? 30, options.horizonDays ?? 30);
  const insert = db.prepare('INSERT INTO availability_rules (doctor_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  for (const rule of options.rules ?? []) insert.run(id, rule.weekday, rule.start, rule.end);
  return id;
}

function makePatient(db, auth, options = {}) {
  const id = options.id ?? auth.newId('pat');
  insertUser(db, auth, { id, role: 'patient', name: options.name ?? 'Test Patient', email: options.email ?? `${id}@patient.test`, phone: options.phone });
  return id;
}

/** Every weekday, nearly all day: used by HTTP tests so a real-time booking always works. */
function allDayRules() {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '23:30' }));
}

async function startServer() {
  const { createApp } = require('../src/app');
  const httpServer = await new Promise((resolve) => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  /** One client = one cookie jar, so two roles can act at the same time. */
  function client() {
    let cookie = null;
    const call = async (method, url, body) => {
      const headers = { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(`${base}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      if (setCookie.length) cookie = setCookie.map((part) => part.split(';')[0]).join('; ');
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON response (e.g. index.html) */
      }
      return { status: response.status, body: json, text, cookie };
    };

    return {
      base,
      call,
      get: (url) => call('GET', url),
      post: (url, body) => call('POST', url, body),
      put: (url, body) => call('PUT', url, body),
      patch: (url, body) => call('PATCH', url, body),
      del: (url) => call('DELETE', url),
      login: async (email, password = DEMO_PASSWORD) => {
        const res = await call('POST', '/api/auth/login', { email, password });
        if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
        return res;
      },
    };
  }

  return { base, client, close: () => new Promise((resolve) => httpServer.close(resolve)) };
}

module.exports = {
  TZ,
  DEMO_PASSWORD,
  freshDbPath,
  fakeNow,
  makeDoctor,
  makePatient,
  allDayRules,
  startServer,
  clock,
};
