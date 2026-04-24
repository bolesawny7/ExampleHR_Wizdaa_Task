import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles } from '../auth/auth.guard.js';
import { ValidationError } from '../common/errors.js';
import { HcmOutboxService } from './hcm-outbox.service.js';
import { HcmOutboxWorker } from './hcm-outbox.worker.js';
import { ReconciliationService } from './reconciliation.service.js';

@Controller('/admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    @Inject(HcmOutboxService) outbox,
    @Inject(HcmOutboxWorker) worker,
    @Inject(ReconciliationService) reconciliation,
  ) {
    this._outbox = outbox;
    this._worker = worker;
    this._reconciliation = reconciliation;
  }

  @Post('/reconcile')
  @Roles('admin')
  async reconcile(@Body() body) {
    if (body?.key) {
      const { employeeId, locationId, leaveType } = body.key;
      if (!employeeId || !locationId || !leaveType) {
        throw new ValidationError('key.employeeId, key.locationId, key.leaveType required');
      }
      return this._reconciliation.reconcileKey({ employeeId, locationId, leaveType });
    }
    return this._reconciliation.reconcileActive({
      sinceMs: body?.sinceMs,
      limit: body?.limit,
    });
  }

  @Get('/outbox')
  @Roles('admin')
  list(@Query('status') status, @Query('limit') limit) {
    return this._outbox.list({
      status,
      limit: limit ? Math.min(500, Number(limit)) : 100,
    });
  }

  @Post('/outbox/:id/retry')
  @Roles('admin')
  async retry(@Param('id') id) {
    const n = Number(id);
    if (!Number.isFinite(n)) throw new ValidationError('invalid id');
    this._outbox.resetForTest(n);
    return this._worker.tick();
  }

  @Post('/outbox/drain')
  @Roles('admin')
  drain() {
    return this._worker.tick();
  }
}
