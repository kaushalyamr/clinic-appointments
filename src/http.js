'use strict';
const { AppError } = require('./errors');

/** Sync-first handler wrapper so thrown AppErrors reach the error middleware. */
function route(handler) {
  return (req, res, next) => {
    try {
      const maybe = handler(req, res, next);
      if (maybe && typeof maybe.catch === 'function') maybe.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

function errorStatus(error) {
  return error instanceof AppError ? error.status : 500;
}

function errorPayload(error, { exposeStack = false } = {}) {
  if (error instanceof AppError) {
    return { error: error.message, details: error.details };
  }
  return { error: 'Something went wrong on our side. Please try again.', ...(exposeStack ? { debug: error.message } : {}) };
}

function parseIds(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') return value.split(',').map(Number).filter(Number.isFinite);
  return [];
}

module.exports = { route, errorStatus, errorPayload, parseIds };
