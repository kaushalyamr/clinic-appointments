'use strict';
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const clock = require('./clock');
const config = require('./config');
const { errorPayload, errorStatus } = require('./http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-site');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));
  app.use(auth.authenticate);

  app.get('/api/meta', (req, res) => {
    const settings = config.load();
    const current = clock.now(settings.timezone);
    res.json({
      clinic_timezone: settings.timezone,
      server_time: new Date(current.instant).toISOString(),
      clinic_date: current.date,
      clinic_time: current.time,
      guard_minutes: settings.rescheduleGuardMinutes,
      reminder_window_minutes: settings.reminderWindowMinutes,
      day_names: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    });
  });

  app.use('/api/auth', require('./routes/auth')());
  app.use('/api/doctors', require('./routes/doctors')());
  app.use('/api/appointments', require('./routes/appointments')());
  app.use('/api/doctor', require('./routes/doctor')());
  app.use('/api/notifications', require('./routes/notifications')());

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request is too large.' });
    }
    const status = errorStatus(error);
    if (status >= 500) console.error('[clinic]', error);
    if (res.headersSent) return next(error);
    res.status(status).json(errorPayload(error));
  });

  return app;
}

module.exports = { createApp, PUBLIC_DIR };
