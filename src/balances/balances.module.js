import { Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { Clock } from '../common/clock.js';
import { DatabaseService } from '../database/database.service.js';
import { BalancesController } from './balances.controller.js';
import { BalancesRepository } from './balances.repository.js';
import { BalancesService } from './balances.service.js';

@Module({
  controllers: [BalancesController],
  providers: [
    {
      provide: BalancesRepository,
      useFactory: (db) => new BalancesRepository(db),
      inject: [DatabaseService],
    },
    {
      provide: BalancesService,
      useFactory: (db, repo, audit, clock) =>
        new BalancesService(db, repo, audit, clock),
      inject: [DatabaseService, BalancesRepository, AuditService, Clock],
    },
  ],
  exports: [BalancesService, BalancesRepository],
})
export class BalancesModule {}
