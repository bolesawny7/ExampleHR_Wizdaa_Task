import {
  DomainError,
  BalanceNotFoundError,
  ForbiddenDomainError,
  HcmPermanentError,
  HcmTransientError,
  InsufficientBalanceError,
  InvalidSignatureError,
  InvalidStateTransitionError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../src/common/errors.js';

describe('errors', () => {
  test('DomainError carries code, status, and extras', () => {
    const err = new DomainError(418, 'TEAPOT', 'I am a teapot', { brew: 'pu-erh' });
    expect(err.getStatus()).toBe(418);
    expect(err.getResponse()).toEqual({
      error: 'TEAPOT',
      message: 'I am a teapot',
      brew: 'pu-erh',
    });
    expect(err.code).toBe('TEAPOT');
  });

  test('Insufficient / state / not found / balance-not-found carry structured payload', () => {
    const a = new InsufficientBalanceError(2, 5);
    expect(a.available).toBe(2);
    expect(a.requested).toBe(5);
    expect(a.getResponse().available).toBe(2);

    const b = new InvalidStateTransitionError('PENDING', 'CONSUMED');
    expect(b.getResponse().from).toBe('PENDING');

    const c = new NotFoundError('Widget', 42);
    expect(c.getResponse().entity).toBe('Widget');

    const d = new BalanceNotFoundError({ employeeId: 'E-1' });
    expect(d.getResponse().employeeId).toBe('E-1');
  });

  test('Forbidden / Unauthorized / InvalidSignature expose default messages', () => {
    expect(new ForbiddenDomainError().getResponse().message).toBe('Forbidden');
    expect(new UnauthorizedError().getResponse().message).toBe('Unauthorized');
    expect(new InvalidSignatureError().getResponse().message).toBe('Invalid signature');
  });

  test('ValidationError accepts details', () => {
    const err = new ValidationError('bad', { field: 'x' });
    expect(err.getResponse().field).toBe('x');
  });

  test('HcmPermanentError / HcmTransientError carry a permanent flag + httpStatus', () => {
    const p = new HcmPermanentError('bad', 422);
    expect(p.permanent).toBe(true);
    expect(p.httpStatus).toBe(422);

    const t = new HcmTransientError('busy', 503);
    expect(t.permanent).toBe(false);
    expect(t.httpStatus).toBe(503);
  });
});
