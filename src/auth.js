'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const { AuthError } = require('./errors');

const COOKIE_NAME = 'clinic_session';
const SCRYPT_KEYLEN = 64;

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + config.load().sessionTtlHours * 3600_000;
  db.get()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, new Date().toISOString(), expiresAt);
  return { token, expiresAt };
}

function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.load().cookieSecure,
    maxAge: Math.max(0, expiresAt - Date.now()),
  };
}

function clearSession(res, token) {
  if (token) {
    db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function tokenFromRequest(req) {
  const header = req.headers.cookie || '';
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === COOKIE_NAME) return decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return null;
}

/** Returns the signed-in user (with doctor profile when present) or null. */
function userFromRequest(req) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const row = db
    .get()
    .prepare(
      `SELECT s.user_id, s.expires_at, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return null;
  if (user.role === 'doctor') {
    user.profile = db.get().prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(user.id) ?? null;
  }
  return user;
}

function authenticate(req, res, next) {
  req.user = userFromRequest(req);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return next(AuthError());
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return next(AuthError());
    if (req.user.role !== role) return next(AuthError(`Only ${role}s can do this.`));
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  newId,
  hashPassword,
  verifyPassword,
  createSession,
  sessionCookieOptions,
  clearSession,
  tokenFromRequest,
  userFromRequest,
  authenticate,
  requireUser,
  requireRole,
};
