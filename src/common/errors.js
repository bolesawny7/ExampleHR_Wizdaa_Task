import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain errors.  Each carries a stable `code` so clients can branch on it
 * without screen-scraping English messages.
 */
export class DomainError extends HttpException {
  constructor(status, code, message, extra = {}) {
    super({ error: code, message, ...extra }, status);
    this.code = code;
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(available, requested) {
    super(HttpStatus.CONFLICT, 'INSUFFICIENT_BALANCE', 'Insufficient balance', {
      available,
      requested,
    });
    this.available = available;
    this.requested = requested;
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(from, to) {
    super(HttpStatus.CONFLICT, 'INVALID_STATE_TRANSITION',
      `Cannot transition from ${from} to ${to}`, { from, to });
  }
}

export class NotFoundError extends DomainError {
  constructor(entity, id) {
    super(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${entity} not found: ${id}`, { entity, id });
  }
}

export class ForbiddenDomainError extends DomainError {
  constructor(message = 'Forbidden') {
    super(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
  }
}

export class InvalidSignatureError extends DomainError {
  constructor(message = 'Invalid signature') {
    super(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message);
  }
}

export class ValidationError extends DomainError {
  constructor(message, details = {}) {
    super(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', message, details);
  }
}

export class ConflictError extends DomainError {
  constructor(code, message, details = {}) {
    super(HttpStatus.CONFLICT, code, message, details);
  }
}

export class BalanceNotFoundError extends DomainError {
  constructor(key) {
    super(HttpStatus.NOT_FOUND, 'BALANCE_NOT_FOUND', 'No balance for key', key);
  }
}

export class HcmPermanentError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.permanent = true;
    this.httpStatus = httpStatus;
  }
}

export class HcmTransientError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.permanent = false;
    this.httpStatus = httpStatus;
  }
}
