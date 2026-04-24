import { JwtService } from '../../src/auth/jwt.service.js';
import { ConfigService } from '../../src/config/config.service.js';

describe('JwtService', () => {
  const config = new ConfigService({
    JWT_SECRET: 'x'.repeat(32), NODE_ENV: 'test',
  });
  const svc = new JwtService(config);

  test('sign/verify round-trips claims', () => {
    const token = svc.sign({ sub: 'E-1', roles: ['employee'] });
    const claims = svc.verify(token);
    expect(claims.sub).toBe('E-1');
    expect(claims.roles).toEqual(['employee']);
  });

  test('verify throws UnauthorizedError on tampered token', () => {
    const token = svc.sign({ sub: 'E-1' });
    const tampered = token.slice(0, -2) + 'zz';
    expect(() => svc.verify(tampered)).toThrow(/Invalid token/);
  });

  test('verify throws on expired token', () => {
    const token = svc.sign({ sub: 'E-1' }, -10);
    expect(() => svc.verify(token)).toThrow(/Invalid token/);
  });
});
