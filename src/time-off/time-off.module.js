import { Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { Clock } from '../common/clock.js';
import { DatabaseService } from '../database/database.service.js';
import { BalancesModule } from '../balances/balances.module.js';
import { BalancesRepository } from '../balances/balances.repository.js';
import { HcmOutboxService } from '../hcm/hcm-outbox.service.js';
import { TimeOffController } from './time-off.controller.js';
import { TimeOffRepository } from './time-off.repository.js';
import { TimeOffService } from './time-off.service.js';

@Module({
  imports: [BalancesModule],
  controllers: [TimeOffController],
  providers: [
    {
      provide: TimeOffRepository,
      useFactory: (db) => new TimeOffRepository(db),
      inject: [DatabaseService],
    },
    {
      provide: TimeOffService,
      useFactory: (db, repo, balancesRepo, audit, clock, outbox) =>
        new TimeOffService(db, repo, balancesRepo, audit, clock, outbox),
      inject: [
        DatabaseService,
        TimeOffRepository,
        BalancesRepository,
        AuditService,
        Clock,
        HcmOutboxService,
      ],
    },
  ],
  exports: [TimeOffService, TimeOffRepository],
})
export class TimeOffModule {}
