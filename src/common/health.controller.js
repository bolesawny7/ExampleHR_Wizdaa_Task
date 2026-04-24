import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { DatabaseService } from '../database/database.service.js';

@Controller('/health')
export class HealthController {
  constructor(@Inject(DatabaseService) db) {
    this._db = db;
  }

  @Public()
  @Get()
  check() {
    try {
      this._db.db.prepare('SELECT 1').get();
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      return { status: 'degraded', db: 'down', error: err.message };
    }
  }
}
