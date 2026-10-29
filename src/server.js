'use strict';
require('./loadEnv').loadEnv();
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');

const settings = config.load();
db.get(); // opens the file and applies the schema

const server = createApp().listen(settings.port, () => {
  console.log(`Clinic app listening on http://localhost:${settings.port} (timezone ${settings.timezone})`);
  console.log('Demo data? run: npm run seed');
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing server.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
