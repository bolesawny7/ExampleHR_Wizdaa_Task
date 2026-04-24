import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from './errors.js';

/**
 * Build a ValidationPipe that produces our unified `ValidationError`
 * response shape instead of Nest's default `BadRequestException`.
 *
 * Used by `main.js` to install the app-global pipe.  Controllers should
 * prefer the `Validate(Dto)` shorthand below so the per-DTO case reads
 * cleanly at the call-site.
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

/**
 * Convenience decorator-body validator: `@Body(Validate(CreateRequestDto))`.
 *
 * Named PascalCase on purpose: it is used exclusively as an argument to
 * the `@Body()` parameter decorator, and PascalCase is the NestJS
 * convention for identifiers that exist to be consumed by decorators.
 */
export function Validate(dto) {
  return buildValidationPipe({ expectedType: dto });
}
