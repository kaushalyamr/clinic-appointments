'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { route, parseIds } = require('../http');
const notifications = require('../services/notifications');

module.exports = function router() {
  const r = express.Router();
  r.use(auth.requireUser);

  r.get(
    '/',
    route((req, res) => {
      const connection = db.get();
      notifications.syncReminders(connection, req.user.id);
      const list = notifications.list(connection, req.user.id);
      res.json({ notifications: list, unread: list.filter((n) => !n.read_at).length });
    }),
  );

  r.post(
    '/read',
    route((req, res) => {
      const all = req.body?.all === true;
      const list = notifications.markRead(db.get(), req.user.id, all ? null : parseIds(req.body?.ids));
      res.json({ notifications: list, unread: list.filter((n) => !n.read_at).length });
    }),
  );

  return r;
};
