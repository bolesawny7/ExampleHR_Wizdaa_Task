import { Body, Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { ConfigService } from '../config/config.service.js';
import { InvalidSignatureError, ValidationError } from '../common/errors.js';
import { ReconciliationService } from './reconciliation.service.js';
import { verify as verifySignature } from './signature.util.js';

/**
 * Inbound HCM webhook routes.
 *
 * Auth is *not* JWT here — HCM uses HMAC signing.  The `@Public()` decorator
 * bypasses the JWT guard; we verify the signature manually using the raw
 * request body captured by a middleware (req.rawBody).
 */
@Controller('/hcm/webhooks')
export class HcmWebhookController {
  constructor(
    @Inject(ConfigService) config,
    @Inject(ReconciliationService) reconciliation,
  ) {
    this._config = config;
    this._reconciliation = reconciliation;
  }

  @Public()
  @Post('/batch')
  @HttpCode(200)
  handleBatch(
    @Req() req,
    @Body() body,
    @Headers('x-hcm-timestamp') timestamp,
    @Headers('x-hcm-signature') signature,
  ) {
    this._verify(req, timestamp, signature);
    if (!body || !Array.isArray(body.balances)) {
      throw new ValidationError('balances[] required');
    }
    for (const b of body.balances) {
      if (!b.employeeId || !b.locationId || !b.leaveType ||
          typeof b.balance !== 'number' || b.balance < 0) {
        throw new ValidationError('invalid balance entry', { entry: b });
      }
    }
    return this._reconciliation.handleBatch({
      batchId: body.batchId ?? null,
      asOf: body.asOf ? Date.parse(body.asOf) : undefined,
      balances: body.balances,
    });
  }

  @Public()
  @Post('/balance')
  @HttpCode(200)
  handleSingle(
    @Req() req,
    @Body() body,
    @Headers('x-hcm-timestamp') timestamp,
    @Headers('x-hcm-signature') signature,
  ) {
    this._verify(req, timestamp, signature);
    if (!body?.employeeId || !body?.locationId || !body?.leaveType ||
        typeof body.balance !== 'number' || body.balance < 0) {
      throw new ValidationError('invalid body');
    }
    return this._reconciliation.handleBatch({
      batchId: null,
      asOf: body.asOf ? Date.parse(body.asOf) : undefined,
      balances: [{
        employeeId: body.employeeId,
        locationId: body.locationId,
        leaveType: body.leaveType,
        balance: body.balance,
        asOf: body.asOf ? Date.parse(body.asOf) : undefined,
      }],
    });
  }

  _verify(req, timestamp, signature) {
    const rawBody = req.rawBody instanceof Buffer
      ? req.rawBody.toString('utf8')
      : typeof req.rawBody === 'string'
        ? req.rawBody
        : JSON.stringify(req.body);
    const ok = verifySignature({
      secret: this._config.hcmWebhookSecret,
      timestampMs: timestamp,
      rawBody,
      signature,
    });
    if (!ok) throw new InvalidSignatureError();
  }
}
