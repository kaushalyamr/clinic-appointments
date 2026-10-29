'use strict';
const fs = require('fs');
const path = require('path');

/** Minimal .env reader so the app has no runtime dependency for config. */
function loadEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

module.exports = { loadEnv };
