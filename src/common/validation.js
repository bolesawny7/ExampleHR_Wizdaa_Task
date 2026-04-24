import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from './errors.js';

/**
 * ValidationPipe configured to throw our own `ValidationError` instead of
 * Nest's default `BadRequestException` so all 4xx responses share the
 * `{ error: '<CODE>', message: ..., details? }` shape.
 */
export function buildValidationPipe(options = {}) {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => {
      const details = errors.map((e) => ({
        field: e.property,
        constraints: e.constraints ?? {},
      }));
      return new ValidationError('Invalid request body', { details });
    },
    ...options,
  });
}
