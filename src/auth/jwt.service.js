import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../common/errors.js';

/**
 * JWT service.
 *
 * In production, replace the HMAC secret with RS256 + JWKS fetched from the
 * ExampleHR SSO.  For the exercise we accept a shared HS256 secret so tests
 * and local dev can mint tokens without key management.
 */
@Injectable()
export class JwtService {
  constructor(config) {
    this._secret = config.jwtSecret;
  }

  sign(claims, expiresInSec = 3600) {
    return jwt.sign(claims, this._secret, { algorithm: 'HS256', expiresIn: expiresInSec });
  }

  verify(token) {
    try {
      return jwt.verify(token, this._secret, { algorithms: ['HS256'] });
    } catch (err) {
      throw new UnauthorizedError(`Invalid token: ${err.message}`);
    }
  }
}
