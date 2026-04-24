import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles } from '../auth/auth.guard.js';
import { BalancesService } from './balances.service.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class BalancesController {
  constructor(@Inject(BalancesService) balances) {
    this._balances = balances;
  }

  @Get('/me/balances')
  @Roles('employee', 'manager', 'admin')
  getMine(@Req() req) {
    return this._balances.getEffectiveBalancesForEmployee(req.user.sub);
  }

  @Get('/admin/balances')
  @Roles('admin')
  listForEmployee(@Query('employeeId') employeeId) {
    if (!employeeId) return [];
    return this._balances.getEffectiveBalancesForEmployee(employeeId);
  }
}
