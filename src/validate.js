'use strict';
const { ValidationError } = require('./errors');
const clock = require('./clock');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

function text(value, field, { max = 200, min = 1 } = {}) {
  if (typeof value !== 'string') throw ValidationError(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw ValidationError(`${field} is required.`);
  if (trimmed.length > max) throw ValidationError(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

function email(value) {
  const e = text(value, 'Email', { max: 160 }).toLowerCase();
  if (!EMAIL_RE.test(e)) throw ValidationError('Enter a valid email address.');
  return e;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw ValidationError('Password must be at least 8 characters.');
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw ValidationError('Password must contain at least one letter and one number.');
  }
  if (value.length > 200) throw ValidationError('Password is too long.');
  return value;
}

function date(value, field = 'Date') {
  const d = text(value, field, { max: 10 });
  if (!DATE_RE.test(d)) throw ValidationError(`${field} must look like 2026-10-28.`);
  const [y, m, day] = d.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) {
    throw ValidationError(`${field} is not a real calendar date.`);
  }
  return d;
}

function time(value, field = 'Time') {
  const t = text(value, field, { max: 5 });
  if (!TIME_RE.test(t)) throw ValidationError(`${field} must be a 24-hour time like 14:30.`);
  return t;
}

function weekday(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 6) throw ValidationError('Day of week must be between Monday and Sunday.');
  return n;
}

function slotLength(value) {
  const n = Number(value);
  if (![15, 30].includes(n)) throw ValidationError('Slot length must be 15 or 30 minutes.');
  return n;
}

function integer(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw ValidationError(`${field} must be a whole number.`);
  if (n < min || n > max) throw ValidationError(`${field} must be between ${min} and ${max}.`);
  return n;
}

function oneOf(value, field, allowed) {
  const v = text(value, field, { max: 40 });
  if (!allowed.includes(v)) throw ValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  return v;
}

/** Booking dates must be a real future-ish day inside the clinic's horizon. */
function dateInHorizon(value, { maxAheadDays, tz }) {
  const d = date(value);
  const today = clock.now(tz).date;
  if (clock.diffDays(today, d) < 0) throw ValidationError('You cannot book a date in the past.');
  if (clock.diffDays(today, d) > maxAheadDays) {
    throw ValidationError(`This doctor only accepts bookings ${maxAheadDays} days ahead.`);
  }
  return d;
}

module.exports = { text, email, password, date, time, weekday, slotLength, integer, oneOf, dateInHorizon, DATE_RE, TIME_RE };
