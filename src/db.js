'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('patient','doctor')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doctor_profiles (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialty             TEXT NOT NULL,
  bio                   TEXT NOT NULL DEFAULT '',
  consultation_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (consultation_fee_cents >= 0),
  slot_length_minutes   INTEGER NOT NULL DEFAULT 30 CHECK (slot_length_minutes IN (15, 30)),
  horizon_days          INTEGER NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 180)
);

CREATE TABLE IF NOT EXISTS availability_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL CHECK (length(start_time) = 5 AND substr(start_time,3,1) = ':'),
  end_time   TEXT NOT NULL CHECK (length(end_time) = 5 AND substr(end_time,3,1) = ':'),
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_rules_doctor ON availability_rules(doctor_id, weekday);

CREATE TABLE IF NOT EXISTS blocked_days (
  doctor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT 'leave',
  PRIMARY KEY (doctor_id, date)
);

CREATE TABLE IF NOT EXISTS appointments (
  id          TEXT PRIMARY KEY,
  doctor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'booked'
              CHECK (status IN ('booked','completed','no_show','cancelled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor ON appointments(doctor_id, date, start_time);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, date);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id TEXT,
  kind           TEXT NOT NULL,
  message        TEXT NOT NULL,
  dedupe_key     TEXT UNIQUE,
  created_at     TEXT NOT NULL,
  read_at        TEXT
);
`;

// One live ("booked") appointment per doctor+date+start, enforced by the DB.
// Cancelled/completed/no-show rows are excluded so a freed slot is bookable again.
const ACTIVE_SLOT_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot
  ON appointments(doctor_id, date, start_time)
  WHERE status = 'booked';
`;

function applySchema(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  db.exec(ACTIVE_SLOT_INDEX);
}

function open(dbPath = config.load().dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  applySchema(db);
  return db;
}

let instance = null;

function get() {
  if (!instance) instance = open();
  return instance;
}

function close() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

module.exports = { open, get, close, applySchema, SCHEMA };
