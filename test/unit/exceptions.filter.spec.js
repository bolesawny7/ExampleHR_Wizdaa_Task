import { HttpException } from '@nestjs/common';
import { AllExceptionsFilter } from '../../src/common/exceptions.filter.js';

function makeHost(capturedStatus = {}, capturedBody = {}) {
  return {
    switchToHttp: () => ({
      getResponse: () => ({
        status(code) {
          capturedStatus.code = code;
          return this;
        },
        json(payload) {
          Object.assign(capturedBody, payload);
          return this;
        },
      }),
    }),
  };
}

describe('AllExceptionsFilter', () => {
  let filter;
  beforeEach(() => {
    filter = new AllExceptionsFilter();
    // Silence Logger.error for unknown-error tests; Nest's Logger writes to stderr.
    filter._logger.error = () => {};
  });

  test('maps an HttpException to its native status and body object', () => {
    const status = {},
      body = {};
    filter.catch(
      new HttpException({ error: 'BOOM', message: 'boom' }, 418),
      makeHost(status, body),
    );
    expect(status.code).toBe(418);
    expect(body.error).toBe('BOOM');
  });

  test('maps a string-body HttpException to { error }', () => {
    const status = {},
      body = {};
    filter.catch(new HttpException('just a string', 400), makeHost(status, body));
    expect(status.code).toBe(400);
    expect(body.error).toBe('just a string');
  });

  test('unknown errors become 500 INTERNAL_ERROR without leaking internals', () => {
    const status = {},
      body = {};
    filter.catch(new Error('secret stack trace'), makeHost(status, body));
    expect(status.code).toBe(500);
    expect(body).toEqual({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  test('non-Error throwables also become 500', () => {
    const status = {},
      body = {};
    filter.catch('a bare string', makeHost(status, body));
    expect(status.code).toBe(500);
    expect(body.error).toBe('INTERNAL_ERROR');
  });
});
