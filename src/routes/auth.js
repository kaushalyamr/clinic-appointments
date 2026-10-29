'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const v = require('../validate');
const { route } = require('../http');
const { ValidationError, ConflictError, AuthError } = require('../errors');
const notifications = require('../services/notifications');

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    specialty: user.profile?.specialty ?? null,
    slot_length_minutes: user.profile?.slot_length_minutes ?? null,
  };
}

function startSession(res, userId) {
  const session = auth.createSession(userId);
  res.cookie(auth.COOKIE_NAME, session.token, auth.sessionCookieOptions(session.expiresAt));
}

module.exports = function router() {
  const r = express.Router();

  r.post(
    '/register',
    route((req, res) => {
      const name = v.text(req.body?.name, 'Full name', { max: 120 });
      const email = v.email(req.body?.email);
      const password = v.password(req.body?.password);
      const phone = req.body?.phone ? v.text(req.body.phone, 'Phone', { max: 32 }) : null;
      if (phone && !/^[+()\d\s-]{7,32}$/.test(phone)) throw ValidationError('Phone must contain digits only.');

      const connection = db.get();
      const clash = connection.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (clash) throw ConflictError('An account already exists for this email.');

      const id = auth.newId('pat');
      connection
        .prepare('INSERT INTO users (id, role, name, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'patient', name, email, phone, auth.hashPassword(password), new Date().toISOString());
      startSession(res, id);
      res.status(201).json({ user: publicUser(connection.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
    }),
  );

  r.post(
    '/login',
    route((req, res) => {
      const email = v.email(req.body?.email);
      const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
      const connection = db.get();
      const user = connection.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !auth.verifyPassword(supplied, user.password_hash)) {
        throw AuthError('Email or password is incorrect.');
      }
      startSession(res, user.id);
      const profile = user.role === 'doctor'
        ? connection.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(user.id)
        : null;
      res.json({ user: publicUser({ ...user, profile }) });
    }),
  );

  r.post(
    '/logout',
    route((req, res) => {
      auth.clearSession(res, auth.tokenFromRequest(req));
      res.json({ ok: true });
    }),
  );

  r.get(
    '/me',
    route((req, res) => {
      if (!req.user) return res.json({ user: null, notifications: [], unread: 0 });
      const connection = db.get();
      notifications.syncReminders(connection, req.user.id);
      const list = notifications.list(connection, req.user.id);
      res.json({
        user: publicUser(req.user),
        notifications: list,
        unread: list.filter((n) => !n.read_at).length,
      });
    }),
  );

  return r;
};
