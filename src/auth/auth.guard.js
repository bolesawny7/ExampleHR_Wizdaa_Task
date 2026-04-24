import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError, ForbiddenDomainError } from '../common/errors.js';
import { JwtService } from './jwt.service.js';

export const ROLES_METADATA_KEY = 'roles';
export const PUBLIC_METADATA_KEY = 'public';

export const Roles = (...roles) => SetMetadata(ROLES_METADATA_KEY, roles);
export const Public = () => SetMetadata(PUBLIC_METADATA_KEY, true);

/**
 * Authenticates via `Authorization: Bearer <jwt>` and authorizes via
 * `@Roles()` metadata.  A route marked `@Public()` skips auth entirely.
 *
 * The verified claims are attached to `req.user`:
 *   { sub, roles[], orgId, managerId }
 */
@Injectable()
export class JwtAuthGuard {
  constructor(
    @Inject(Reflector) reflector,
    @Inject(JwtService) jwtService,
  ) {
    this._reflector = reflector;
    this._jwt = jwtService;
  }

  canActivate(context) {
    const isPublic = this._reflector.getAllAndOverride(PUBLIC_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    const claims = this._jwt.verify(token);
    req.user = {
      sub: claims.sub,
      roles: Array.isArray(claims.roles) ? claims.roles : [],
      orgId: claims.orgId,
      managerId: claims.managerId ?? null,
    };

    const requiredRoles = this._reflector.getAllAndOverride(ROLES_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0) {
      const ok = requiredRoles.some((r) => req.user.roles.includes(r));
      if (!ok) {
        throw new ForbiddenDomainError(`Requires role: ${requiredRoles.join(' | ')}`);
      }
    }
    return true;
  }
}
