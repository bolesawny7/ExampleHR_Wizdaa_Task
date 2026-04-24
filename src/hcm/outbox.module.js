import { Global, Module } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { ConfigService } from '../config/config.service.js';
import { DatabaseService } from '../database/database.service.js';
import { HcmOutboxService } from './hcm-outbox.service.js';

/**
 * The outbox is a cross-cutting primitive used by TimeOffService (producer)
 * and HcmOutboxWorker (consumer).  Putting it in its own global module
 * avoids a circular dependency between time-off and hcm modules.
 */
@Global()
@Module({
  providers: [
    {
      provide: HcmOutboxService,
      useFactory: (db, clock, config) => new HcmOutboxService(db, clock, config),
      inject: [DatabaseService, Clock, ConfigService],
    },
  ],
  exports: [HcmOutboxService],
})
export class OutboxModule {}
