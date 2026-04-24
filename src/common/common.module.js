import { Global, Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from './audit.service.js';
import { Clock } from './clock.js';
import { IdempotencyService } from './idempotency.service.js';

@Global()
@Module({
  providers: [
    { provide: Clock, useFactory: () => new Clock() },
    {
      provide: AuditService,
      useFactory: (db, clock) => new AuditService(db.db, clock),
      inject: [DatabaseService, Clock],
    },
    {
      provide: IdempotencyService,
      useFactory: (db, clock) => new IdempotencyService(db.db, clock),
      inject: [DatabaseService, Clock],
    },
  ],
  exports: [Clock, AuditService, IdempotencyService],
})
export class CommonModule {}
