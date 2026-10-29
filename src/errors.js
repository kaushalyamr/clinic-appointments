'use strict';

class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

const ValidationError = (message, details) => new AppError(400, message, details);
const AuthError = (message = 'Please sign in to continue.') => new AppError(401, message);
const ForbiddenError = (message = 'You do not have access to this.') => new AppError(403, message);
const NotFoundError = (message = 'Not found.') => new AppError(404, message);
const ConflictError = (message, details) => new AppError(409, message, details);

module.exports = { AppError, ValidationError, AuthError, ForbiddenError, NotFoundError, ConflictError };
