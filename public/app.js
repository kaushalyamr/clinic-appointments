// Cedar Clinic — dependency-free SPA. Talks to /api only; all rules are enforced server-side.
const state = {
  meta: null,
  user: null,
  notifications: [],
  unread: 0,
  doctors: [],
  specialties: [],
  filter: { q: '', specialty: '' },
  detail: null,
  slots: null,
  booking: { date: '', time: '', error: '', busy: false, rescheduleId: null },
  mine: { upcoming: [], past: [] },
  noticeError: '',
  day: { date: '', appointments: [], free: [], closed: null, stats: null, weekly: null },
  avail: null,
  leave: { list: [], date: '', reason: '', error: '' },
  authDraft: { email: '', password: '', name: '', phone: '', mode: 'login', error: '' },
};

const app = document.getElementById('app');
const bell = document.getElementById('bell');
const bellCount = document.getElementById('bell-count');
const whoEl = document.getElementById('who');
const signoutBtn = document.getElementById('signout');
const tabsEl = document.getElementById('tabs');
const toastEl = document.getElementById('toast');

/* ---------------- helpers ---------------- */
const h = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });

function tzFormatter(options) {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: state.meta?.clinic_timezone ?? 'UTC' });
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  return tzFormatter({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${dateStr}T12:00:00Z`));
}

function fmtDateLong(dateStr) {
  return tzFormatter({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${dateStr}T12:00:00Z`));
}

function fmtInstant(iso) {
  return tzFormatter({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function countdown(minutes) {
  if (minutes == null) return '';
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

const STATUS_LABEL = { booked: 'Booked', completed: 'Completed', no_show: 'No show', cancelled: 'Cancelled' };
const STATUS_TONE = { completed: 'done', no_show: 'miss', cancelled: 'cancelled' };
const CLOSED_REASON = {
  no_availability: 'The doctor does not consult on this weekday.',
  blocked: 'The doctor is on leave today.',
  fully_past: 'Every slot for today has already started.',
  fully_booked: 'Every slot on this day is booked.',
  past: 'This date has passed.',
};

/** "Dr. Ayesha Khan" -> "AK" for the avatar tiles. */
function initials(name) {
  return String(name ?? '')
    .replace(/^(?:dr|mr|mrs|ms|prof)\.?\s+/i, '')
    .replace(/\b(?:dr|mr|mrs|ms|prof)\.?\s+/gi, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

let toastTimer = null;
function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('bad', bad);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, bad ? 6000 : 3500);
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(json?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return json ?? {};
}

const get = (path) => api('GET', path);
const post = (path, body = {}) => api('POST', path, body);
const put = (path, body = {}) => api('PUT', path, body);
const patch = (path, body = {}) => api('PATCH', path, body);
const del = (path) => api('DELETE', path);

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

const today = () => state.meta?.clinic_date ?? '';
const addDays = (date, n) => {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
};

/* ---------------- chrome ---------------- */
function paintChrome() {
  const signedIn = Boolean(state.user);
  [bell, whoEl, signoutBtn].forEach((el) => {
    el.hidden = !signedIn;
  });
  whoEl.textContent = signedIn ? state.user.name : '';
  bellCount.hidden = state.unread === 0;
  bellCount.textContent = String(state.unread);

  const items = [];
  if (signedIn) {
    if (state.user.role === 'patient') {
      items.push(['#/doctors', 'Find a doctor'], ['#/appointments', 'My appointments']);
    } else {
      items.push(['#/doctor/today', 'Today'], ['#/doctor/availability', 'Availability'], ['#/doctor/leave', 'Days off']);
    }
    items.push(['#/notifications', 'Reminders']);
  }
  tabsEl.hidden = items.length === 0;
  const route = location.hash || '#/';
  tabsEl.innerHTML = items
    .map(
      ([href, label]) =>
        `<a class="tab" href="${href}" ${route.startsWith(href) ? 'aria-current="true"' : ''}>${h(label)}</a>`,
    )
    .join('');
}

/* ---------------- views ---------------- */
function authView() {
  const draft = state.authDraft;
  const isLogin = draft.mode === 'login';
  return `
    <div class="auth-wrap">
      <section class="auth-hero">
        <h1>Cedar Clinic</h1>
        <p>Book a specialist in three taps, and manage the clinic day from any phone.</p>
        <ul class="features">
          <li><span>1</span><div>Pick a doctor, then a date — only genuinely free slots are shown.</div></li>
          <li><span>2</span><div>Two patients can never hold the same slot: the database refuses the second booking.</div></li>
          <li><span>3</span><div>Cancel or move a visit up to two hours before it starts, with reminders an hour out.</div></li>
        </ul>
      </section>
      <section class="card">
        <h2 class="card-title">${isLogin ? 'Sign in' : 'Create a patient account'}</h2>
        <p class="sub">Book a doctor, or manage your clinic day.</p>
        ${draft.error ? `<div class="alert" role="alert">${h(draft.error)}</div>` : ''}
        <form id="auth-form" novalidate>
          ${
            isLogin
              ? ''
              : `<div class="field"><label for="name">Full name</label><input id="name" name="name" value="${h(draft.name)}" autocomplete="name" required /></div>`
          }
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" inputmode="email" value="${h(draft.email)}" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" value="${h(draft.password)}" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required />
          </div>
          ${
            isLogin
              ? ''
              : `<div class="field"><label for="phone">Phone (optional)</label><input id="phone" name="phone" type="tel" value="${h(draft.phone)}" autocomplete="tel" placeholder="+92 300 0000000" /></div>`
          }
          <div class="form-actions">
            <button class="button" type="submit">${isLogin ? 'Sign in' : 'Sign up'}</button>
            <button class="link" type="button" data-action="switch-mode">${isLogin ? 'New here? Create an account' : 'I already have an account'}</button>
          </div>
        </form>
        <div class="demo">
          <p class="hint">Demo accounts (password <b>clinic1234</b>) — tap to sign straight in:</p>
          <button type="button" data-action="quick-fill" data-email="ayesha.khan@clinic.dev"><span><b>Dr. Ayesha Khan</b> · Cardiology</span><em>Doctor</em></button>
          <button type="button" data-action="quick-fill" data-email="usman.tariq@clinic.dev"><span><b>Dr. Usman Tariq</b> · General Medicine</span><em>Doctor</em></button>
          <button type="button" data-action="quick-fill" data-email="ali.raza@patient.dev"><span><b>Ali Raza</b> · has bookings</span><em>Patient</em></button>
          <button type="button" data-action="quick-fill" data-email="hina.fatima@patient.dev"><span><b>Hina Fatima</b> · dermatology</span><em>Patient</em></button>
        </div>
      </section>
    </div>`;
}

function doctorCard(doctor) {
  const openLabel = doctor.next_open_date
    ? `${doctor.next_open_free_slots} free · ${fmtDate(doctor.next_open_date)}`
    : 'No open slots';
  return `
    <article class="card stack">
      <div class="spread">
        <div class="who-line">
          <span class="avatar" aria-hidden="true">${h(initials(doctor.name))}</span>
          <div>
            <h2>${h(doctor.name)}</h2>
            <p class="sub">${h(doctor.specialty)} · ${doctor.slot_length_minutes}-minute visits</p>
          </div>
        </div>
        <span class="chip mut">${h(money(doctor.consultation_fee_cents))}</span>
      </div>
      <p class="hint">${h(doctor.bio)}</p>
      <p class="hint">${h(doctor.weekly || 'No weekly hours set')}</p>
      <div class="spread">
        <span class="chip ${doctor.next_open_date ? 'booked' : ''}">${h(openLabel)}</span>
        <button class="button secondary" type="button" data-action="open-doctor" data-id="${h(doctor.id)}">See slots</button>
      </div>
    </article>`;
}

function doctorsView() {
  const chips = [`<button class="chip" type="button" data-action="filter-specialty" data-value="" aria-pressed="${state.filter.specialty === ''}">All</button>`]
    .concat(
      state.specialties.map(
        (item) =>
          `<button class="chip" type="button" data-action="filter-specialty" data-value="${h(item)}" aria-pressed="${state.filter.specialty === item}">${h(item)}</button>`,
      ),
    )
    .join('');

  const list = state.doctors.length
    ? `<div class="grid cols">${state.doctors.map(doctorCard).join('')}</div>`
    : '<div class="card"><p class="sub">No doctors match that search yet. Try another speciality or clear the filter.</p></div>';

  return `
    <section class="card">
      <div class="card-head">
        <h1>Find a doctor</h1>
        <p class="sub">${state.doctors.length} shown</p>
      </div>
      <div class="row" role="search">
        <input id="doctor-search" type="search" placeholder="Search name or speciality" value="${h(state.filter.q)}" aria-label="Search doctors" />
      </div>
      <div class="row">${chips}</div>
    </section>
    ${list}`;
}

function slotPanel() {
  const { slots, booking } = state;
  if (!slots) return '<p class="loading">Loading slots…</p>';
  if (booking.error) return `<div class="alert" role="alert">${h(booking.error)}</div>`;
  if (!slots.slots.length) {
    const next = nextOpenDate(state.detail);
    return `
      <div class="card note">${h(slots.message || 'No free slots on this date.')}</div>
      ${
        next
          ? `<div class="row"><button class="button secondary" type="button" data-action="jump-date" data-date="${h(next)}">Try ${h(fmtDate(next))} instead</button></div>`
          : ''
      }`;
  }
  return `
    <p class="hint">${slots.slots.length} free ${slots.slot_length_minutes}-minute slot${slots.slots.length === 1 ? '' : 's'}.</p>
    <div class="slot-grid">
      ${slots.slots
        .map(
          (slot) =>
            `<button class="slot" type="button" data-action="pick-slot" data-time="${h(slot.start)}" aria-pressed="${booking.time === slot.start}">${h(slot.start)}</button>`,
        )
        .join('')}
    </div>`;
}

/** First date inside the horizon with an open window — used only for a suggestion; the server still decides. */
function nextOpenDate(detail) {
  if (!detail) return null;
  const open = new Set(detail.open_weekdays);
  const blocked = new Set(detail.blocked_days.map((row) => row.date));
  const [hh, mm] = (state.meta?.clinic_time ?? '00:00').split(':').map(Number);
  const nowMinutes = hh * 60 + mm;
  for (let i = 0; i <= detail.doctor.horizon_days; i += 1) {
    const date = addDays(today(), i);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (!open.has(weekday) || blocked.has(date)) continue;
    const stillPossible = detail.rules.some(
      (rule) => rule.weekday === weekday && Number(rule.end_time.slice(0, 2)) * 60 + Number(rule.end_time.slice(3)) > nowMinutes,
    );
    if (i === 0 && !stillPossible) continue;
    return date;
  }
  return null;
}

function doctorDetailView() {
  const { detail, slots, booking } = state;
  if (!detail) return '<p class="loading">Loading doctor…</p>';
  const doctor = detail.doctor;
  const blocked = new Set(detail.blocked_days.map((row) => row.date));
  const mode = booking.rescheduleId ? 'Move this appointment' : 'Book a slot';

  return `
    <div class="split">
      <section class="card stack">
        <div class="who-line">
          <span class="avatar lg" aria-hidden="true">${h(initials(doctor.name))}</span>
          <div>
            <h1>${h(doctor.name)}</h1>
            <p class="sub">${h(doctor.specialty)} · ${doctor.slot_length_minutes}-minute visits · ${h(money(doctor.consultation_fee_cents))}</p>
          </div>
        </div>
        <p class="hint">${h(doctor.bio)}</p>
        <h2>${h(mode)}</h2>
        ${booking.rescheduleId ? `<div class="note">Pick a new time, then confirm. Changes are blocked within ${Math.round(state.meta.guard_minutes / 60)} hours of the visit.</div>` : ''}
        <div class="field-row two">
          <div class="field">
            <label for="date-input">Date</label>
            <input id="date-input" type="date" value="${h(booking.date)}" min="${h(today())}" max="${h(addDays(today(), doctor.horizon_days))}" data-action="pick-date" />
          </div>
          <div class="field">
            <label for="day-preview">Selected day</label>
            <input id="day-preview" type="text" value="${h(fmtDateLong(booking.date))}${blocked.has(booking.date) ? ' · day off' : ''}" readonly />
          </div>
        </div>
        ${booking.error ? `<div class="alert" role="alert">${h(booking.error)}</div>` : ''}
        ${slotPanel()}
        <div class="form-actions">
          <button class="button" type="button" data-action="confirm-book" ${booking.time && !booking.busy ? '' : 'disabled'}>
            ${booking.busy ? 'Saving…' : booking.rescheduleId ? 'Confirm new time' : `Confirm ${booking.time ? h(booking.time) : 'booking'}`}
          </button>
          ${booking.rescheduleId ? '<button class="button plain" type="button" data-action="cancel-reschedule">Keep current time</button>' : ''}
        </div>
        <p class="hint">Weekly hours: ${h(detail.weekly || 'none set')}</p>
      </section>

      <aside class="stack">
        <section class="card">
          <h2>Open weekdays</h2>
          <div class="row">
            ${detail.open_weekdays
              .map((weekday) => `<span class="chip booked">${h(detail.rules.find((rule) => rule.weekday === weekday)?.day ?? '')}</span>`)
              .filter((value, index, all) => all.indexOf(value) === index)
              .join('')}
          </div>
          <h3>Hours</h3>
          <ul class="sub">
            ${detail.rules.map((rule) => `<li>${h(rule.day)} ${h(rule.start_time)}–${h(rule.end_time)}</li>`).join('')}
          </ul>
          ${
            detail.blocked_days.length
              ? `<h3>Days off</h3><div class="row">${detail.blocked_days
                  .map((row) => `<span class="chip mut">${h(fmtDate(row.date))} · ${h(row.reason)}</span>`)
                  .join('')}</div>`
              : ''
          }
        </section>
        <section class="card">
          <h2>How booking works</h2>
          <p class="sub">Slots are generated from the doctor’s weekly hours. Already-booked and past times are never shown, and the database blocks a second booking on the same slot.</p>
        </section>
      </aside>
    </div>`;
}

function visitCard(row, actorRole) {
  const when = `${fmtDate(row.date)} · ${h(row.start_time)}–${h(row.end_time)}`;
  const guardHint =
    row.status === 'booked' && actorRole === 'patient' && !row.can_cancel
      ? `<p class="hint">Locked: inside the ${Math.round(state.meta.guard_minutes / 60)}-hour window. Call the clinic to change it.</p>`
      : actorRole === 'doctor' && row.status === 'booked' && !row.can_close
        ? '<p class="hint">Upcoming — the actions unlock once the slot time arrives.</p>'
        : '';
  const patientActions =
    actorRole === 'patient' && row.status === 'booked'
      ? `
        <button class="button secondary" type="button" data-action="start-reschedule" data-id="${h(row.id)}" data-doctor="${h(row.doctor_id)}" data-date="${h(row.date)}" ${row.can_reschedule ? '' : 'disabled'}>Reschedule</button>
        <button class="button danger" type="button" data-action="cancel-appointment" data-id="${h(row.id)}" ${row.can_cancel ? '' : 'disabled'}>Cancel</button>`
      : '';
  const doctorActions =
    actorRole === 'doctor' && row.status === 'booked'
      ? `
        <button class="button ok" type="button" data-action="mark-status" data-id="${h(row.id)}" data-status="completed" ${row.can_close ? '' : 'disabled'}>Completed</button>
        <button class="button danger" type="button" data-action="mark-status" data-id="${h(row.id)}" data-status="no_show" ${row.can_close ? '' : 'disabled'}>No show</button>`
      : '';

  const otherName = actorRole === 'doctor' ? row.patient_name : row.doctor_name;

  return `
    <article class="visit ${STATUS_TONE[row.status] ?? ''}">
      <div class="visit-time">${h(row.start_time)}<small>${h(fmtDate(row.date).split(',')[0])}</small></div>
      <div>
        <div class="who-line">
          <span class="avatar sm ${actorRole === 'doctor' ? 'accent' : 'plain'}" aria-hidden="true">${h(initials(otherName))}</span>
          <h3>${actorRole === 'doctor' ? h(row.patient_name) : `Dr. ${h(row.doctor_name.replace(/^Dr\.\s*/i, ''))}`}</h3>
        </div>
        <p class="visit-meta">${h(when)} · ${actorRole === 'doctor' ? h(row.patient_email) : h(row.specialty)}${
          row.minutes_away >= 0 && row.status === 'booked' ? ` · ${h(countdown(row.minutes_away))}` : ''
        }</p>
        <div class="row">
          <span class="chip ${h(row.status)}">${h(STATUS_LABEL[row.status] ?? row.status)}</span>
          ${row.status === 'booked' && row.minutes_away >= 0 && row.minutes_away <= state.meta.reminder_window_minutes ? '<span class="chip mut">Reminder set</span>' : ''}
        </div>
        <div class="visit-actions">${patientActions}${doctorActions}</div>
        ${guardHint}
      </div>
    </article>`;
}

function appointmentsView() {
  const { mine, noticeError } = state;
  return `
    <section class="card">
      <div class="card-head">
        <h1>My appointments</h1>
        <button class="button" type="button" data-action="new-booking">Book another visit</button>
      </div>
      ${noticeError ? `<div class="alert" role="alert">${h(noticeError)}</div>` : ''}
    </section>
    <section class="card">
      <h2>Upcoming (${mine.upcoming.length})</h2>
      ${mine.upcoming.length ? mine.upcoming.map((row) => visitCard(row, 'patient')).join('') : '<p class="sub">Nothing booked yet. Find a doctor to get started.</p>'}
    </section>
    <section class="card">
      <h2>Past &amp; cancelled (${mine.past.length})</h2>
      ${mine.past.length ? mine.past.map((row) => visitCard(row, 'patient')).join('') : '<p class="sub">No history yet.</p>'}
    </section>`;
}

function notificationsView() {
  const list = state.notifications;
  return `
    <section class="card">
      <div class="spread">
        <div>
          <h1>Reminders</h1>
          <p class="sub">In-app alerts appear one hour before a visit, and whenever a booking changes.</p>
        </div>
        <button class="button secondary" type="button" data-action="read-all" ${state.unread ? '' : 'disabled'}>Mark all read</button>
      </div>
      ${
        list.length
          ? list
              .map(
                (note) => `
            <div class="note-item ${note.read_at ? '' : 'unread'}">
              <div>
                <strong>${h(note.kind === 'reminder' ? 'Reminder' : note.kind === 'rescheduled' ? 'Rescheduled' : note.kind === 'booking_confirmed' ? 'Confirmed' : 'Update')}</strong>
                <p>${h(note.message)}</p>
              </div>
              <span class="note-time">${h(fmtInstant(note.created_at))}${note.read_at ? ' · read' : ''}</span>
            </div>`,
              )
              .join('')
          : '<p class="sub">No notifications yet.</p>'
      }
    </section>`;
}

function doctorDayView() {
  const { day } = state;
  const stats = day.stats ?? { total: 0, booked: 0, completed: 0, no_show: 0, cancelled: 0 };
  const isToday = day.date === state.meta.clinic_date;
  return `
    <section class="card">
      <div class="card-head">
        <h1>${isToday ? 'Today’s schedule' : fmtDateLong(day.date)}</h1>
        <div class="row">
          <button class="button plain" type="button" data-action="day-shift" data-delta="-1">Prev day</button>
          <button class="button secondary" type="button" data-action="day-shift" data-delta="1">Next day</button>
        </div>
      </div>
      <p class="sub">${h(fmtDateLong(day.date))} · clinic clock ${h(state.meta.clinic_time)}</p>
      <div class="stat-grid">
        <div class="stat"><b>${stats.total}</b><span>visits</span></div>
        <div class="stat open"><b>${stats.booked ?? 0}</b><span>still open</span></div>
        <div class="stat done"><b>${stats.completed ?? 0}</b><span>completed</span></div>
        <div class="stat miss"><b>${stats.no_show ?? 0}</b><span>no shows</span></div>
      </div>
    </section>
    <section class="card">
      <h2>Appointments in time order</h2>
      ${day.appointments.length ? day.appointments.map((row) => visitCard(row, 'doctor')).join('') : '<p class="sub">No appointments on this day.</p>'}
    </section>
    <section class="card">
      <div class="spread">
        <div>
          <h2>Still free</h2>
          <p class="sub">${day.free.length ? `${day.free.length} open slot${day.free.length === 1 ? '' : 's'} on this day.` : CLOSED_REASON[day.closed] ?? 'No open slots.'}</p>
        </div>
        <span class="chip ${day.free.length ? 'booked' : ''}">${day.free.length} free</span>
      </div>
    </section>`;
}

function availabilityView() {
  const draft = state.avail;
  if (!draft) return '<p class="loading">Loading availability…</p>';
  return `
    <section class="card">
      <div class="card-head">
        <h1>Weekly availability</h1>
        <p class="sub">Patients can only book inside these hours.</p>
      </div>
      ${draft.error ? `<div class="alert" role="alert">${h(draft.error)}</div>` : ''}
      <h3>Visit length</h3>
      <div class="radio-row">
        ${[15, 30]
          .map(
            (minutes) => `
          <label><input type="radio" name="slot-length" value="${minutes}" ${draft.slot_length_minutes === minutes ? 'checked' : ''} data-action="slot-length" /> ${minutes} minutes</label>`,
          )
          .join('')}
      </div>
      <p class="hint">A window must be at least one visit long; slots fill it from the start time.</p>

      <h3>Working days</h3>
      ${draft.days
        .map(
          (day) => `
        <div class="day-row ${day.on ? '' : 'off'}">
          <div class="day-head">
            <input type="checkbox" id="day-${day.weekday}" ${day.on ? 'checked' : ''} data-action="toggle-day" data-weekday="${day.weekday}" />
            <label for="day-${day.weekday}"><strong>${h(day.name)}</strong></label>
          </div>
          <div class="windows">
            ${day.windows
              .map(
                (window, index) => `
              <div class="window">
                <input type="time" value="${h(window.start_time)}" data-action="window-time" data-weekday="${day.weekday}" data-index="${index}" data-which="start_time" aria-label="${h(day.name)} start" />
                <span>to</span>
                <input type="time" value="${h(window.end_time)}" data-action="window-time" data-weekday="${day.weekday}" data-index="${index}" data-which="end_time" aria-label="${h(day.name)} end" />
                <button class="link" type="button" data-action="remove-window" data-weekday="${day.weekday}" data-index="${index}">Remove</button>
              </div>`,
              )
              .join('')}
            <div><button class="link" type="button" data-action="add-window" data-weekday="${day.weekday}">+ add another window</button></div>
          </div>
        </div>`,
        )
        .join('')}
      <div class="form-actions">
        <button class="button" type="button" data-action="save-availability" ${draft.busy ? 'disabled' : ''}>${draft.busy ? 'Saving…' : 'Save availability'}</button>
        <button class="button plain" type="button" data-action="reset-availability">Reset</button>
      </div>
      <p class="hint">Booking horizon: <b>${draft.horizon_days}</b> days ahead · fee ${h(money(draft.consultation_fee_cents))}</p>
    </section>`;
}

function leaveView() {
  const { leave } = state;
  return `
    <div class="split">
      <section class="card">
        <h1>Days off</h1>
        <p class="sub">Block a single day and every slot on it disappears for patients. Existing bookings are not removed automatically — move or cancel them from Today.</p>
        ${leave.error ? `<div class="alert" role="alert">${h(leave.error)}</div>` : ''}
        <form id="leave-form" class="field-row two">
          <div class="field">
            <label for="leave-date">Date</label>
            <input id="leave-date" name="leave-date" type="date" min="${h(today())}" value="${h(leave.date)}" required />
          </div>
          <div class="field">
            <label for="leave-reason">Reason (optional)</label>
            <input id="leave-reason" name="leave-reason" type="text" maxlength="60" value="${h(leave.reason)}" placeholder="Conference, surgery list…" />
          </div>
          <div class="form-actions"><button class="button" type="submit">Block this day</button></div>
        </form>
      </section>
      <section class="card">
        <h2>Blocked days</h2>
        ${
          leave.list.length
            ? leave.list
                .map(
                  (row) => `
              <div class="spread">
                <span class="chip mut">${h(fmtDateLong(row.date))} · ${h(row.reason)}</span>
                <button class="link" type="button" data-action="remove-leave" data-date="${h(row.date)}">Unblock</button>
              </div>`,
                )
                .join('')
            : '<p class="sub">None. Your weekly hours apply to every date.</p>'
        }
      </section>
    </div>`;
}

/* ---------------- routing ---------------- */
function parseHash() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, params: new URLSearchParams(query) };
}

async function loadRouteData(route) {
  const [head, second] = route.parts;
  try {
    if (!state.user) return;

    if (head === 'doctors' && second) {
      state.detail = await get(`/api/doctors/${second}`);
      const date = state.booking.date || today();
      state.booking.date = date;
      state.slots = null;
      state.slots = await get(`/api/doctors/${second}/slots?date=${date}`);
      return;
    }
    if (head === 'doctors') {
      const [list, specialties] = await Promise.all([get('/api/doctors'), get('/api/doctors/specialties')]);
      state.doctors = list.doctors;
      state.specialties = specialties.specialties;
      return;
    }
    if (head === 'appointments') {
      state.mine = await get('/api/appointments/mine');
      state.noticeError = '';
      return;
    }
    if (head === 'notifications') {
      const data = await get('/api/notifications');
      state.notifications = data.notifications;
      state.unread = data.unread;
      return;
    }
    if (head === 'doctor') {
      if (second === 'availability') {
        if (!state.avail || !state.avail.edited) state.avail = await buildAvailDraft();
        return;
      }
      if (second === 'leave') {
        const data = await get('/api/doctor/blocked-days');
        state.leave.list = data.blocked_days;
        return;
      }
      const date = route.params.get('date') || state.meta.clinic_date;
      state.day.date = date;
      const data = await get(`/api/doctor/day?date=${date}`);
      state.day.appointments = data.appointments;
      state.day.free = data.free_slots;
      state.day.closed = data.closed;
      if (!state.day.stats) {
        const overview = await get('/api/doctor/overview');
        state.day.stats = overview.stats;
        state.day.weekly = overview.weekly;
      }
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function refreshMe() {
  const data = await get('/api/auth/me');
  state.user = data.user;
  state.notifications = data.notifications ?? [];
  state.unread = data.unread ?? 0;
}

function defaultLanding() {
  if (!state.user) return '#/login';
  return state.user.role === 'doctor' ? '#/doctor/today' : '#/doctors';
}

function render() {
  paintChrome();
  const route = parseHash();
  const head = route.parts[0] ?? '';

  if (!state.user) {
    app.innerHTML = authView();
    return;
  }
  if (head === '' || head === 'login') {
    go(defaultLanding());
    return;
  }
  if (head === 'doctors') {
    app.innerHTML = route.parts[1] ? doctorDetailView() : doctorsView();
    return;
  }
  if (head === 'appointments') {
    app.innerHTML = appointmentsView();
    return;
  }
  if (head === 'notifications') {
    app.innerHTML = notificationsView();
    return;
  }
  if (head === 'doctor') {
    const view = route.parts[1];
    if (view === 'availability') {
      app.innerHTML = availabilityView();
      return;
    }
    if (view === 'leave') {
      app.innerHTML = leaveView();
      return;
    }
    app.innerHTML = doctorDayView();
    return;
  }
  app.innerHTML = '<section class="card"><h1>Page not found</h1><p class="sub">Use the tabs above to navigate.</p></section>';
}

async function navigate() {
  await loadRouteData(parseHash());
  render();
}

/* ---------------- availability draft ---------------- */
const DAY_ORDER = [
  { weekday: 1, name: 'Monday' },
  { weekday: 2, name: 'Tuesday' },
  { weekday: 3, name: 'Wednesday' },
  { weekday: 4, name: 'Thursday' },
  { weekday: 5, name: 'Friday' },
  { weekday: 6, name: 'Saturday' },
  { weekday: 0, name: 'Sunday' },
];

async function buildAvailDraft() {
  const { weekly } = await get('/api/doctor/availability');
  return {
    slot_length_minutes: weekly.slot_length_minutes,
    horizon_days: weekly.horizon_days,
    consultation_fee_cents: weekly.consultation_fee_cents,
    edited: false,
    busy: false,
    error: '',
    days: DAY_ORDER.map(({ weekday, name }) => {
      const windows = weekly.rules
        .filter((rule) => rule.weekday === weekday)
        .map((rule) => ({ start_time: rule.start_time, end_time: rule.end_time }));
      return { weekday, name, on: windows.length > 0, windows: windows.length ? windows : [{ start_time: '10:00', end_time: '13:00' }] };
    }),
  };
}

function draftRules(draft) {
  const rules = [];
  for (const day of draft.days) {
    if (!day.on) continue;
    for (const window of day.windows) rules.push({ weekday: day.weekday, start_time: window.start_time, end_time: window.end_time });
  }
  return rules;
}

/* ---------------- actions ---------------- */
const actions = {
  'switch-mode'() {
    state.authDraft.mode = state.authDraft.mode === 'login' ? 'register' : 'login';
    state.authDraft.error = '';
    render();
  },
  async 'quick-fill'(element) {
    state.authDraft.email = element.dataset.email;
    state.authDraft.password = 'clinic1234';
    state.authDraft.mode = 'login';
    state.authDraft.error = '';
    render();
    const form = document.getElementById('auth-form');
    if (form) form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  },
  async 'logout'() {
    await post('/api/auth/logout');
    state.user = null;
    state.detail = null;
    state.avail = null;
    go('#/login');
  },
  'bell'() {
    go('#/notifications');
  },
  'new-booking'() {
    go('#/doctors');
  },
  'open-doctor'(element) {
    state.booking = { date: today(), time: '', error: '', busy: false, rescheduleId: null };
    state.slots = null;
    go(`#/doctors/${element.dataset.id}`);
  },
  'filter-specialty'(element) {
    state.filter.specialty = element.dataset.value;
    loadRouteData(parseHash()).then(render);
  },
  'jump-date'(element) {
    state.booking.date = element.dataset.date;
    state.booking.time = '';
    state.booking.error = '';
    state.slots = null;
    render();
    loadRouteData(parseHash()).then(render);
  },
  'pick-slot'(element) {
    state.booking.time = state.booking.time === element.dataset.time ? '' : element.dataset.time;
    state.booking.error = '';
    render();
  },
  async 'confirm-book'() {
    const { booking, detail } = state;
    if (!booking.time || !booking.date) return;
    state.booking.busy = true;
    render();
    try {
      if (booking.rescheduleId) {
        const result = await post(`/api/appointments/${booking.rescheduleId}/reschedule`, {
          date: booking.date,
          time: booking.time,
        });
        toast(result.message);
        state.booking = { date: today(), time: '', error: '', busy: false, rescheduleId: null };
        await refreshMe();
        go('#/appointments');
        return;
      }
      const result = await post('/api/appointments', { doctor_id: detail.doctor.id, date: booking.date, time: booking.time });
      toast(result.message);
      state.booking.time = '';
      await refreshMe();
      state.slots = await get(`/api/doctors/${detail.doctor.id}/slots?date=${booking.date}`);
      render();
    } catch (error) {
      state.booking.error = error.message;
      state.booking.busy = false;
      // A conflict means someone else won the slot our grid still shows.
      if (error.status === 409) state.slots = await get(`/api/doctors/${detail.doctor.id}/slots?date=${booking.date}`).catch(() => state.slots);
      render();
    }
  },
  'start-reschedule'(element) {
    state.booking = { date: element.dataset.date || today(), time: '', error: '', busy: false, rescheduleId: element.dataset.id };
    state.detail = null;
    state.slots = null;
    go(`#/doctors/${element.dataset.doctor}`);
  },
  'cancel-reschedule'() {
    state.booking = { date: today(), time: '', error: '', busy: false, rescheduleId: null };
    go('#/appointments');
  },
  async 'cancel-appointment'(element) {
    if (!confirm('Cancel this appointment? The slot becomes free for other patients.')) return;
    try {
      const result = await post(`/api/appointments/${element.dataset.id}/cancel`);
      state.noticeError = '';
      toast(result.message);
      state.mine = await get('/api/appointments/mine');
      render();
    } catch (error) {
      state.noticeError = error.message;
      render();
    }
  },
  async 'mark-status'(element) {
    try {
      const result = await patch(`/api/doctor/appointments/${element.dataset.id}/status`, { status: element.dataset.status });
      toast(result.message);
      const data = await get(`/api/doctor/day?date=${state.day.date}`);
      state.day.appointments = data.appointments;
      state.day.free = data.free_slots;
      state.day.stats = null;
      const overview = await get('/api/doctor/overview');
      state.day.stats = overview.stats;
      render();
    } catch (error) {
      toast(error.message, true);
    }
  },
  'day-shift'(element) {
    const delta = Number(element.dataset.delta);
    go(`#/doctor/today?date=${addDays(state.day.date, delta)}`);
  },
  'toggle-day'(element) {
    const draft = state.avail;
    const day = draft.days.find((item) => item.weekday === Number(element.dataset.weekday));
    day.on = element.checked;
    draft.edited = true;
    render();
  },
  'slot-length'(element) {
    state.avail.slot_length_minutes = Number(element.value);
    state.avail.edited = true;
    render();
  },
  'window-time'(element) {
    const draft = state.avail;
    const day = draft.days.find((item) => item.weekday === Number(element.dataset.weekday));
    day.windows[Number(element.dataset.index)][element.dataset.which] = element.value;
    draft.edited = true;
  },
  'add-window'(element) {
    const day = state.avail.days.find((item) => item.weekday === Number(element.dataset.weekday));
    day.windows.push({ start_time: '17:00', end_time: '20:00' });
    day.on = true;
    state.avail.edited = true;
    render();
  },
  'remove-window'(element) {
    const day = state.avail.days.find((item) => item.weekday === Number(element.dataset.weekday));
    day.windows.splice(Number(element.dataset.index), 1);
    if (day.windows.length === 0) day.on = false;
    state.avail.edited = true;
    render();
  },
  async 'save-availability'() {
    const draft = state.avail;
    draft.busy = true;
    draft.error = '';
    render();
    try {
      const result = await put('/api/doctor/availability', {
        slot_length_minutes: draft.slot_length_minutes,
        rules: draftRules(draft),
      });
      draft.edited = false;
      draft.busy = false;
      toast(result.message);
      state.avail = await buildAvailDraft();
      render();
    } catch (error) {
      draft.busy = false;
      draft.error = error.message;
      render();
    }
  },
  async 'reset-availability'() {
    state.avail = await buildAvailDraft();
    render();
  },
  async 'remove-leave'(element) {
    try {
      const result = await del(`/api/doctor/blocked-days/${element.dataset.date}`);
      state.leave.list = result.blocked_days;
      state.leave.error = '';
      toast(result.message);
      render();
    } catch (error) {
      state.leave.error = error.message;
      render();
    }
  },
  async 'read-all'() {
    await post('/api/notifications/read', { all: true });
    const data = await get('/api/notifications');
    state.notifications = data.notifications;
    state.unread = data.unread;
    render();
  },
};

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  const action = actions[element.dataset.action];
  if (action) {
    event.preventDefault();
    action(element, event);
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'auth-form') {
    event.preventDefault();
    const data = new FormData(form);
    state.authDraft.email = data.get('email') ?? '';
    state.authDraft.password = data.get('password') ?? '';
    state.authDraft.name = data.get('name') ?? '';
    state.authDraft.phone = data.get('phone') ?? '';
    try {
      if (state.authDraft.mode === 'login') {
        await post('/api/auth/login', { email: state.authDraft.email, password: state.authDraft.password });
      } else {
        await post('/api/auth/register', {
          name: state.authDraft.name,
          email: state.authDraft.email,
          password: state.authDraft.password,
          phone: state.authDraft.phone || undefined,
        });
      }
      state.authDraft = { email: '', password: '', name: '', phone: '', mode: 'login', error: '' };
      await refreshMe();
      toast(`Welcome, ${state.user.name.split(' ')[0]}.`);
      go(defaultLanding());
    } catch (error) {
      state.authDraft.error = error.message;
      render();
    }
    return;
  }

  if (form.id === 'leave-form') {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const result = await post('/api/doctor/blocked-days', { date: data.get('leave-date'), reason: data.get('leave-reason') || undefined });
      state.leave.list = result.blocked_days;
      state.leave.date = '';
      state.leave.reason = '';
      state.leave.error = '';
      toast(result.message);
      render();
    } catch (error) {
      state.leave.error = error.message;
      render();
    }
  }
});

document.addEventListener('change', (event) => {
  const element = event.target;
  if (element.dataset.action === 'pick-date') {
    state.booking.date = element.value;
    state.booking.time = '';
    state.booking.error = '';
    state.slots = null;
    render();
    loadRouteData(parseHash()).then(render);
    return;
  }
  if (element.id === 'leave-date') state.leave.date = element.value;
  if (element.id === 'leave-reason') state.leave.reason = element.value;
});

let searchTimer = null;
document.addEventListener('input', (event) => {
  if (event.target.id !== 'doctor-search') return;
  state.filter.q = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRouteData(parseHash()).then(render), 250);
});

window.addEventListener('hashchange', navigate);

/* ---------------- boot ---------------- */
async function boot() {
  state.meta = await get('/api/meta');
  await refreshMe();
  if (state.user) {
    // Poll so the 1-hour reminder lands while the tab is open.
    setInterval(async () => {
      try {
        const data = await get('/api/notifications');
        if (data.unread > state.unread) toast('A reminder just arrived.');
        state.notifications = data.notifications;
        state.unread = data.unread;
        paintChrome();
      } catch {
        /* the tab may be offline; the next poll retries */
      }
    }, 60000);
  }
  if (!location.hash || location.hash === '#/') location.replace(defaultLanding());
  await navigate();
}

boot().catch((error) => {
  app.innerHTML = `<section class="card"><h1>Could not start</h1><p class="sub">${h(error.message)}</p></section>`;
});
