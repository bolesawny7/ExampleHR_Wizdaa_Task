import { Injectable } from '@nestjs/common';

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

@Injectable()
export class ConfigService {
  constructor(overrides = {}) {
    const env = { ...process.env, ...overrides };

    this.nodeEnv = env.NODE_ENV || 'development';
    this.port = int(env.PORT, 3000);
    this.jwtSecret =
      env.JWT_SECRET || (this.nodeEnv === 'test' ? 'test-secret-please-change' : null);
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET is required');
    }

    this.databasePath = env.DATABASE_PATH || ':memory:';

    this.hcmBaseUrl = env.HCM_BASE_URL || 'http://localhost:4000';
    this.hcmWebhookSecret = env.HCM_WEBHOOK_SECRET || 'test-webhook-secret';
    this.hcmApiKey = env.HCM_API_KEY || 'test-api-key';

    this.reconciliationCron = env.RECONCILIATION_CRON || '*/15 * * * *';
    this.outboxIntervalMs = int(env.OUTBOX_INTERVAL_MS, 2000);
    this.outboxBatchSize = int(env.OUTBOX_BATCH_SIZE, 20);
    this.outboxMaxAttempts = int(env.OUTBOX_MAX_ATTEMPTS, 8);

    this.rateLimitPerMin = int(env.RATE_LIMIT_PER_MIN, 100);

    this.disableBackgroundJobs = bool(env.DISABLE_BACKGROUND_JOBS, this.nodeEnv === 'test');
  }

  isProd() {
    return this.nodeEnv === 'production';
  }
}
