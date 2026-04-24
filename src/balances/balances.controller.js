import { Controller, Get, Inject, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.guard.js';
import { BalancesService } from './balances.service.js';

// JwtAuthGuard is registered globally via APP_GUARD in AppModule; route
// authorization is expressed with @Roles() and service-layer ownership checks.
@Controller()
export class BalancesController {
  constructor(@Inject(BalancesService) balances) {
    this._balances = balances;
  }

  @Get('/me/balances')
  @Roles('employee', 'manager', 'admin')
  getMine(@Req() req) {
    return this._balances.getEffectiveBalancesForEmployee(req.user.sub);
  }
}
