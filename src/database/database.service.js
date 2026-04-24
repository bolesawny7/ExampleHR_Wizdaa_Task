import { Injectable, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

/**
 * Thin wrapper around better-sqlite3 that:
 *  - Owns the DB handle lifecycle.
 *  - Applies the schema on boot (idempotent CREATE IF NOT EXISTS).
 *  - Exposes a `transaction(fn)` helper using BEGIN IMMEDIATE so concurrent
 *    writers serialize deterministically (see TRD §C2).
 *
 * better-sqlite3 is synchronous — SQLite's underlying I/O is synchronous,
 * and a sync API makes transaction semantics trivial to reason about.
 */
@Injectable()
export class DatabaseService {
  constructor(config) {
    this._logger = new Logger('DatabaseService');
    this._config = config;
    this._db = null;
  }

  onModuleInit() {
    this.open();
  }

  onModuleDestroy() {
    this.close();
  }

  open() {
    if (this._db) return;
    const dbPath = this._config.databasePath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('busy_timeout = 5000');
    this._db.exec(SCHEMA_SQL);
    if (process.env.NODE_ENV !== 'test') {
      this._logger.log(`SQLite opened at ${dbPath}`);
    }
  }

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  get db() {
    if (!this._db) this.open();
    return this._db;
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  /**
   * Run `fn(db, payload)` inside a BEGIN IMMEDIATE transaction.  Returns the
   * callback's return value, or throws (in which case the txn is rolled back).
   *
   * We use IMMEDIATE (not DEFERRED) so the write lock is taken up front and
   * concurrent writers serialize against each other rather than failing at
   * COMMIT with SQLITE_BUSY.
   */
  transaction(fn) {
    const db = this.db;
    const inner = db.transaction((payload) => fn(db, payload));
    return (payload) => inner.immediate(payload);
  }
}
