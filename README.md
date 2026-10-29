# Cedar Clinic — Appointment Booking

A full-stack appointment system for a small clinic. Patients browse doctors, see only the
slots that are genuinely free, and book; doctors own their weekly availability, take days
off, and run the day's schedule from a dashboard.

Backend: Node.js + Express, SQLite through the built-in `node:sqlite` module.
Frontend: a dependency-free vanilla JS single-page app (hash routing) that works on a phone
and a laptop with the same code.

---

## Quick start

Requires **Node.js 24 or newer** (`node:sqlite` is built in from Node 23.4; no native
compile step, no database server to install).

```bash
npm install
cp .env.example .env      # optional — every setting has a working default
npm run seed              # demo doctors, patients and appointments
npm start                 # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm start` | Runs the server on `PORT` (default 3000). |
| `npm run dev` | Same, with `node --watch` auto-restart. |
| `npm run seed` | Wipes `data/clinic.db` and writes the demo dataset. Idempotent. |
| `npm test` | 59 backend tests (`node --test`), each on its own temporary database. |

Every setting is documented in [`.env.example`](.env.example) — port, database path, clinic
timezone, session lifetime, the 2-hour guard, the reminder window, and the seed password.
Nothing secret is committed; `.env` and `data/` are git-ignored.

## Demo logins

Password for **all** accounts: `clinic1234`

| Role | Email | Name |
| --- | --- | --- |
| Doctor | `ayesha.khan@clinic.dev` | Dr. Ayesha Khan — Cardiology, 30-min slots |
| Doctor | `bilal.ahmed@clinic.dev` | Dr. Bilal Ahmed — Dermatology, 15-min slots |
| Doctor | `sana.mirza@clinic.dev` | Dr. Sana Mirza — Pediatrics (on leave 2026-11-05) |
| Doctor | `usman.tariq@clinic.dev` | Dr. Usman Tariq — General Medicine |
| Patient | `ali.raza@patient.dev` | Ali Raza |
| Patient | `hina.fatima@patient.dev` | Hina Fatima |
| Patient | `john.doe@patient.dev` | John Doe |
| Patient | `maryam.siddiqui@patient.dev` | Maryam Siddiqui |

The seed deliberately books a few visits that have **already started today**, so the doctor
dashboard has working *Mark completed* / *No-show* buttons the moment you sign in, and leaves
later ones as *Upcoming*. Sign in as two patients in separate browser profiles to race for the
same slot.

---

## Data model

```
users ──┬── doctor_profiles (1:1, doctors only)
        │     specialty · bio · fee · slot_length_minutes (15|30) · horizon_days
        ├── availability_rules (1:N)  weekday + start_time + end_time  → weekly windows
        ├── blocked_days (1:N)        (doctor_id, date) PK + reason    → a day off
        ├── sessions (1:N)            token_hash PK, expires_at
        └── notifications (1:N)       kind · message · dedupe_key UNIQUE · read_at

appointments (doctor_id, patient_id, date, start_time, end_time, status)
  status ∈ booked | completed | no_show | cancelled
```

- **Weekly availability** is a set of windows per weekday, so a doctor can consult Monday
  09:00–11:00 **and** 17:00–19:30. A `CHECK (start_time < end_time)` keeps windows sane.
- **`blocked_days`** overrides the weekly pattern: a leave day exposes zero slots without
  touching the recurring rules.
- **Appointments store wall-clock values** (`date`, `start_time`, `end_time`) rather than UTC
  instants, because a clinic schedule is meaningless once you move it across timezones. The
  absolute time is derived at request time for ordering and the guard rule.
- Slot length lives on the doctor, so 15- and 30-minute consultants coexist.

## API

| | |
| --- | --- |
| `POST /api/auth/register` · `login` · `logout` · `GET /me` | session cookie auth |
| `GET /api/doctors` · `/specialties` · `/:id` · `/:id/slots?date=` | public browsing (any signed-in user) |
| `POST /api/appointments` | book a slot |
| `GET /api/appointments/mine` · `POST /:id/cancel` · `POST /:id/reschedule` | patient dashboard |
| `GET /api/doctor/day` · `/overview` | today's schedule, ordered |
| `PATCH /api/doctor/appointments/:id/status` | completed / no-show |
| `GET|PUT /api/doctor/availability` | weekly windows |
| `GET|POST|DELETE /api/doctor/blocked-days` | days off |
| `GET /api/notifications` · `POST /api/notifications/read` | reminder bell |

All input is validated on the server (`src/validate.js`) before touching the database: email
shape, password length, `HH:MM` times, ISO dates inside the booking horizon, weekday ranges,
slot lengths restricted to 15/30, status whitelists, and window overlap. Failures return
`400` with a sentence a patient can act on (`"Enter a valid email address."`), which the UI
shows in an alert above the form and as a toast; unexpected failures return a generic message
and never leak a stack trace.

---

## Design decisions worth explaining

### No double booking — enforced by the database

The real risk is two patients clicking *Confirm* on the same slot in the same millisecond.
Three layers handle it:

1. A **partial unique index** is the backstop:
   ```sql
   CREATE UNIQUE INDEX uq_active_slot
     ON appointments(doctor_id, date, start_time)
     WHERE status = 'booked';
   ```
   Partial so a cancelled or completed visit frees the slot again instead of blocking it
   forever. Even if every other check is bypassed, SQLite refuses the second insert.
2. Booking and rescheduling run inside **`BEGIN IMMEDIATE`** transactions, so the read
   ("is this slot free?") and the write share one lock and cannot interleave.
3. The route maps a constraint violation to a friendly **`409 That slot has just been
   taken`**, and the client re-fetches the slot grid so the gone slot disappears.

`tests/concurrency.test.js` proves it: eight worker threads race for one slot and exactly one
must win.

### One clinic clock, not the browser's

Slot maths, "has this slot already started?", and the 2-hour guard are all computed in
`CLINIC_TIMEZONE` (default `Asia/Karachi`) via `Intl.DateTimeFormat.formatToParts`. Server and
browser agree even when the laptop is in another zone, and no appointment shifts when the
clinic changes daylight rules. Time is passed around as a wall-clock string plus the absolute
instant, so the UI never has to guess.

### The clock is injectable

`clock.now(tz)` returns `{ date, time, instant }`, and every service accepts a `now` override.
That is what makes the interesting tests possible — asserting the guard *exactly* at 119 and
121 minutes before a slot, or that a slot starting precisely now is not offered — without
sleeping or mocking dates globally.

### Free-slot browsing, not "book then hope"

`GET /api/doctors/:id/slots` returns only slots that are open, in the future, and unbooked,
plus a machine-readable `closed` reason (`blocked`, `no_availability`, `fully_past`, …). The
UI turns that reason into a plain sentence and, when a date is dead, offers a one-click
**"Try Fri 30 Oct instead"** jump to the next genuinely open day.

### The 2-hour rule

Patients cannot cancel or reschedule within `RESCHEDULE_GUARD_MINUTES` (120) of the start. The
server is authoritative; the UI disables the buttons and explains *why* ("Locked: inside the
2-hour window. Call the clinic to change it."). Doctors are deliberately **not** bound by it —
they manage their own diary.

### Reminders

`syncReminders()` runs on each notification poll and inserts a reminder for any booked visit
starting within `REMINDER_WINDOW_MINUTES`. `notifications.dedupe_key UNIQUE` +
`INSERT OR IGNORE` makes the sweep idempotent, so a patient polling every 60 seconds still
sees exactly one reminder per visit.

### Security & hygiene

Passwords hashed with `scrypt`; session tokens are random and stored only as SHA-256 hashes in
an `httpOnly`, `SameSite=Lax` cookie. CSP with `script-src 'self'`, `X-Frame-Options: DENY`,
`nosniff`, a 32 kB JSON body cap, and every user-controlled string escaped by `h()` before it
reaches the DOM. Prepared statements throughout — no string-built SQL.

### Frontend with no framework

One ES module, a hash router, and a render function per view. Actions are delegated through
`data-action` attributes, so re-rendering never orphans listeners. Styles are a token-driven,
mobile-first sheet with a single 720 px breakpoint, `prefers-reduced-motion` respected, and
42–46 px touch targets — the same markup serves the phone and the desktop layouts.

---

## Tests

`npm test` — 59 tests, no network, each on a throwaway SQLite file.

| File | Covers |
| --- | --- |
| `tests/slots.test.js` | window → slot filling, 15/30 lengths, overrun guard, multi-window days, past-slot filter, blocked days, closed days |
| `tests/booking.test.js` | happy path, validation failures, conflict handling, slot-length changes |
| `tests/concurrency.test.js` | 8 worker threads racing one slot; exactly one booking survives |
| `tests/guards.test.js` | the 2-hour boundary at 119/121 min, doctor exemption, cancelled/completed transitions, ownership checks |
| `tests/api.test.js` | real HTTP: registration, login, cookie session, role enforcement, 404/400 shapes |

## What is done, and what is not

**Done** — roles and auth, 4 seeded doctors across 4 specialties, 15/30-minute slots, free-slot
browsing with closed-day explanations, booking, cancel and reschedule, the 2-hour guard, doctor
day dashboard with completed/no-show, weekly availability editor with multiple windows per day,
days off, patient upcoming/past dashboard, in-app reminders one hour before, mobile and desktop
layouts, server-side validation with field errors, database-level double-booking prevention,
59 automated tests, seed script, `.env.example`, README.

**Not done** — email/SMS delivery (reminders are in-app only; the wiring is a single function),
recurring appointments, a clinic-admin role for managing doctors, waitlists, payment, and
offline/PWA support. Doctor profiles are seeded rather than self-edited beyond availability.

**Demo video** — record your own 3–5 minute screen capture: sign in as a patient → book a slot
→ show it on *My appointments* → sign in as the doctor → complete the visit → change an
availability window and show the patient view updating.

## AI tools used

Qoder (agentic coding assistant) was used to draft and refactor code, write the test suite, and
review the UI. Every design decision above — the partial unique index, the wall-clock timezone
model, the injectable clock, the guard semantics — was chosen and verified for this project;
all code was read, run and tested locally.

## Layout

```
src/            app.js (express wiring) · server.js · config.js · loadEnv.js
  db.js         schema + pragmas + the partial unique index
  clock.js      clinic wall-clock helpers (injectable)
  auth.js       scrypt hashing, sessions, cookie handling
  validate.js   every server-side input rule
  names.js      "Dr." label helper
  services/     slots.js · availability.js · appointments.js · notifications.js
  routes/       auth · doctors · doctor · appointments · notifications
public/         index.html · app.js (SPA) · styles.css
scripts/seed.js demo dataset
tests/          59 node:test cases
```
