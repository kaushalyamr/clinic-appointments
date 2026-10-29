'use strict';
// Pure slot generation: no DB, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');

const { slotsFromRules } = require('../src/services/slots');
const { fakeNow } = require('./helpers');

// 2026-11-02 is a Monday, 2026-11-03 a Tuesday, 2026-11-04 a Wednesday.
const MONDAY = '2026-11-02';
const TUESDAY = '2026-11-03';
const SUNDAY = '2026-11-08';

const monWin = { weekday: 1, start_time: '10:00', end_time: '13:00' };

function starts(slots) {
  return slots.map((slot) => slot.start);
}

test('fills a 3-hour window with 30-minute slots', () => {
  const { slots } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '08:00'),
  });
  assert.deepEqual(starts(slots), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
  assert.equal(slots[0].end, '10:30');
  assert.equal(slots.at(-1).end, '13:00');
});

test('never emits a slot that overruns the window end', () => {
  const { slots } = slotsFromRules({
    rules: [{ weekday: 1, start_time: '10:00', end_time: '13:14' }],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '08:00'),
  });
  assert.equal(slots.length, 6);
  assert.equal(slots.at(-1).start, '12:30');
});

test('15-minute length doubles the slot count', () => {
  const { slots } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 15,
    date: MONDAY,
    current: fakeNow(MONDAY, '08:00'),
  });
  assert.equal(slots.length, 12);
  assert.deepEqual(starts(slots).slice(0, 3), ['10:00', '10:15', '10:30']);
});

test('combines two windows on the same day and keeps them ordered', () => {
  const { slots } = slotsFromRules({
    rules: [
      { weekday: 1, start_time: '17:00', end_time: '18:00' },
      monWin,
    ],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '08:00'),
  });
  assert.deepEqual(starts(slots), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '17:00', '17:30']);
});

test('only uses windows for the requested weekday', () => {
  const tuesday = slotsFromRules({ rules: [monWin], slotMinutes: 30, date: TUESDAY, current: fakeNow(MONDAY, '08:00') });
  assert.deepEqual(tuesday.slots, []);
  assert.equal(tuesday.closed, 'no_availability');
});

test('drops today’s slots that have already started', () => {
  const { slots } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '11:20'),
  });
  assert.deepEqual(starts(slots), ['11:30', '12:00', '12:30']);
});

test('a slot starting exactly now is not offered', () => {
  const { slots } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '10:00'),
  });
  assert.ok(!starts(slots).includes('10:00'));
  assert.equal(slots[0].start, '10:30');
});

test('a whole day in the past is closed', () => {
  const { slots, closed } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(TUESDAY, '09:00'),
  });
  assert.deepEqual(slots, []);
  assert.equal(closed, 'past');
});

test('a blocked day hides every slot', () => {
  const { slots, closed } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '08:00'),
    blocked: true,
  });
  assert.deepEqual(slots, []);
  assert.equal(closed, 'blocked');
});

test('reports a closed day once the last slot has started', () => {
  const { slots, closed } = slotsFromRules({
    rules: [monWin],
    slotMinutes: 30,
    date: MONDAY,
    current: fakeNow(MONDAY, '13:00'),
  });
  assert.deepEqual(slots, []);
  assert.equal(closed, 'fully_past');
});

test('a day with no rules at all is closed', () => {
  const { slots, closed } = slotsFromRules({ rules: [], slotMinutes: 30, date: SUNDAY, current: fakeNow(MONDAY, '08:00') });
  assert.deepEqual(slots, []);
  assert.equal(closed, 'no_availability');
});
