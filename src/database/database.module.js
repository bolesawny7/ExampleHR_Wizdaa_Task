import { Global, Module } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { DatabaseService } from './database.service.js';

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (config) => new DatabaseService(config),
      inject: [ConfigService],
    },
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
