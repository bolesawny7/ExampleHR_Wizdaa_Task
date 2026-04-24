import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/auth.guard.js';
import { ValidationError } from '../common/errors.js';
import { Validate } from '../common/validation.js';
import { ReconcileDto } from './dto/reconcile.dto.js';
import { HcmOutboxService } from './hcm-outbox.service.js';
import { HcmOutboxWorker } from './hcm-outbox.worker.js';
import { ReconciliationService } from './reconciliation.service.js';

// JwtAuthGuard runs globally via APP_GUARD; only @Roles('admin') needed here.
@Controller('/admin')
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
  reconcile(@Body(Validate(ReconcileDto)) body) {
    if (body.key) {
      return this._reconciliation.reconcileKey(body.key);
    }
    return this._reconciliation.reconcileActive({
      sinceMs: body.sinceMs,
      limit: body.limit,
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
  retry(@Param('id') id) {
    const n = Number(id);
    if (!Number.isFinite(n)) throw new ValidationError('invalid id');
    this._outbox.resetToPending(n);
    return this._worker.tick();
  }

  @Post('/outbox/drain')
  @Roles('admin')
  drain() {
    return this._worker.tick();
  }
}
