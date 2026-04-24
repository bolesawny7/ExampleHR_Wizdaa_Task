import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { InvalidSignatureError } from '../common/errors.js';
import { verify as verifySignature } from './signature.util.js';

/**
 * Verifies the HMAC signature on inbound HCM webhook requests.  Runs as a
 * Nest guard, which fires *before* body-level `ValidationPipe` — so an
 * attacker with an invalid signature never learns anything about which
 * fields our DTO expects.
 */
@Injectable()
export class HcmSignatureGuard {
  constructor(@Inject(ConfigService) config) {
    this._secret = config.hcmWebhookSecret;
  }

  canActivate(context) {
    const req = context.switchToHttp().getRequest();
    const timestamp = req.headers['x-hcm-timestamp'];
    const signature = req.headers['x-hcm-signature'];
    const rawBody =
      req.rawBody instanceof Buffer ? req.rawBody.toString('utf8') : JSON.stringify(req.body ?? {});
    const ok = verifySignature({
      secret: this._secret,
      timestampMs: timestamp,
      rawBody,
      signature,
    });
    if (!ok) throw new InvalidSignatureError();
    return true;
  }
}
