'use strict';

/** Seeded doctors are stored as "Dr. Ayesha Khan"; self-registered ones may not be. */
function doctorLabel(name) {
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

module.exports = { doctorLabel };
