import { Catch, HttpException, Logger } from '@nestjs/common';

/**
 * Converts any thrown error to a JSON response with a stable `error` code.
 *
 * Unknown errors are logged at ERROR level but *not* leaked to the client
 * beyond a generic INTERNAL_ERROR code — PII and stack traces must never
 * cross the trust boundary.
 */
@Catch()
export class AllExceptionsFilter {
  constructor() {
    this._logger = new Logger('ExceptionsFilter');
  }

  catch(exception, host) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { error: body } : body);
      return;
    }
    this._logger.error(exception?.stack || String(exception));
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  }
}
