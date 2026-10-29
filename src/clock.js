'use strict';
// All calendar/timezone helpers live here so the rest of the app can reason in
// "clinic wall clock" time (e.g. 14:30 on 2026-10-28) instead of host timezone.

const FORMATTERS = new Map();

function formatter(tz) {
  const key = `${tz}`;
  let fmt = FORMATTERS.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    FORMATTERS.set(key, fmt);
  }
  return fmt;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Break an instant into clinic wall-clock parts. */
function parts(tz, instant = Date.now()) {
  const found = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const { type, value } of formatter(tz).formatToParts(instant)) {
    if (type === 'weekday') found.weekday = WEEKDAYS[value.slice(0, 3)] ?? 0;
    else if (type in found) found[type] = Number(value);
  }
  if (found.hour === 24) found.hour = 0; // some engines emit 24 for midnight
  return found;
}

function datePart(tz, instant) {
  const p = parts(tz, instant);
  return `${pad(p.year)}-${pad(p.month)}-${pad(p.day)}`;
}

function timePart(tz, instant) {
  const p = parts(tz, instant);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Minutes between midnight and an instant, in clinic time. */
function minutesOf(tz, instant = Date.now()) {
  const p = parts(tz, instant);
  return p.hour * 60 + p.minute;
}

function toInstant(tz, date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // The offset can differ on each side of a DST boundary, so refine once.
  let instant = naive - offsetAt(tz, naive);
  return naive - offsetAt(tz, instant);
}

function offsetAt(tz, instant) {
  const p = parts(tz, instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** 'YYYY-MM-DD' + n days, pure calendar arithmetic. */
function addDays(date, n) {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function toTime(minutes) {
  return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

/** Snapshot of "now" used by slot generation and booking guards. */
function now(tz = require('./config').load().timezone) {
  const instant = Date.now();
  return {
    instant,
    date: datePart(tz, instant),
    time: timePart(tz, instant),
    minutes: minutesOf(tz, instant),
    weekday: parts(tz, instant).weekday,
  };
}

module.exports = {
  parts,
  datePart,
  timePart,
  minutesOf,
  toInstant,
  offsetAt,
  addDays,
  diffDays,
  weekdayOf,
  toMinutes,
  toTime,
  now,
};
