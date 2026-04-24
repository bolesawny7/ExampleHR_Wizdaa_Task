import { Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { Clock } from '../common/clock.js';
import { ConfigService } from '../config/config.service.js';
import { BalancesRepository } from '../balances/balances.repository.js';
import { BalancesService } from '../balances/balances.service.js';
import { BalancesModule } from '../balances/balances.module.js';
import { TimeOffModule } from '../time-off/time-off.module.js';
import { TimeOffService } from '../time-off/time-off.service.js';
import { AdminController } from './admin.controller.js';
import { HcmClient } from './hcm.client.js';
import { HcmWebhookController } from './hcm.controller.js';
import { HcmOutboxService } from './hcm-outbox.service.js';
import { HcmOutboxWorker } from './hcm-outbox.worker.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [BalancesModule, TimeOffModule],
  controllers: [HcmWebhookController, AdminController],
  providers: [
    {
      provide: HcmClient,
      useFactory: (config) => new HcmClient(config),
      inject: [ConfigService],
    },
    {
      provide: HcmOutboxWorker,
      useFactory: (outbox, hcm, timeOff, balances, audit, clock, config) =>
        new HcmOutboxWorker(outbox, hcm, timeOff, balances, audit, clock, config),
      inject: [
        HcmOutboxService, HcmClient, TimeOffService, BalancesService,
        AuditService, Clock, ConfigService,
      ],
    },
    {
      provide: ReconciliationService,
      useFactory: (balancesService, balancesRepo, timeOff, hcm, clock) =>
        new ReconciliationService(balancesService, balancesRepo, timeOff, hcm, clock),
      inject: [
        BalancesService, BalancesRepository, TimeOffService, HcmClient, Clock,
      ],
    },
  ],
  exports: [HcmClient, HcmOutboxWorker, ReconciliationService],
})
export class HcmModule {}
