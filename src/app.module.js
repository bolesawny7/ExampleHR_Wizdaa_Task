import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/auth.guard.js';
import { BalancesModule } from './balances/balances.module.js';
import { AllExceptionsFilter } from './common/exceptions.filter.js';
import { HealthController } from './common/health.controller.js';
import { CommonModule } from './common/common.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HcmModule } from './hcm/hcm.module.js';
import { OutboxModule } from './hcm/outbox.module.js';
import { TimeOffModule } from './time-off/time-off.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CommonModule,
    AuthModule,
    OutboxModule,
    BalancesModule,
    TimeOffModule,
    HcmModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useFactory: () => new AllExceptionsFilter() },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
})
export class AppModule {}
