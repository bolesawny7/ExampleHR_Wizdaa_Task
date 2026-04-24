import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { buildValidationPipe } from '../common/validation.js';
import { HcmBalanceDto, HcmBatchDto } from './dto/hcm-webhook.dto.js';
import { ReconciliationService } from './reconciliation.service.js';
import { HcmSignatureGuard } from './signature.guard.js';

const validateBatch = buildValidationPipe({ expectedType: HcmBatchDto });
const validateBalance = buildValidationPipe({ expectedType: HcmBalanceDto });

/**
 * Inbound HCM webhook routes.
 *
 * `@Public()` skips the JWT guard — these routes are authenticated by
 * HMAC signature instead, enforced by `HcmSignatureGuard`.  The guard
 * runs before the body `ValidationPipe` so an attacker with a bad
 * signature learns nothing about the DTO shape.
 */
@Controller('/hcm/webhooks')
@Public()
@UseGuards(HcmSignatureGuard)
export class HcmWebhookController {
  constructor(@Inject(ReconciliationService) reconciliation) {
    this._reconciliation = reconciliation;
  }

  @Post('/batch')
  @HttpCode(200)
  handleBatch(@Body(validateBatch) body) {
    return this._reconciliation.handleBatch({
      batchId: body.batchId ?? null,
      asOf: body.asOf ? Date.parse(body.asOf) : undefined,
      balances: body.balances,
    });
  }

  @Post('/balance')
  @HttpCode(200)
  handleSingle(@Body(validateBalance) body) {
    const asOf = body.asOf ? Date.parse(body.asOf) : undefined;
    return this._reconciliation.handleBatch({
      batchId: null,
      asOf,
      balances: [{ ...body, asOf }],
    });
  }
}
