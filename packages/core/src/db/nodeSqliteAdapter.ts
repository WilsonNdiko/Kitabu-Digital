/**
 * Node adapter over the built-in `node:sqlite` (ADR-011). Used for development,
 * CI, tests, and the server-side tooling. App shells bring their own adapter
 * (better-sqlite3 + SQLCipher on Windows; quick-sqlite/op-sqlite on Android).
 */

import { DatabaseSync } from 'node:sqlite';
import type { SqlitePort, SqliteStatement, SqliteValue } from './port.ts';
import { KitabuError } from '../foundation/errors.ts';

export class NodeSqliteAdapter implements SqlitePort {
  readonly #db: DatabaseSync;
  #inTransaction = false;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.#db.prepare(sql);
    return {
      run: (...params: SqliteValue[]) => stmt.run(...params) as { changes: number | bigint; lastInsertRowid: number | bigint },
      get: (...params: SqliteValue[]) => stmt.get(...params) as unknown,
      all: (...params: SqliteValue[]) => stmt.all(...params) as unknown[],
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) {
      throw new KitabuError('NESTED_TRANSACTION', 'Internal error: nested transaction', 'transaction() called inside a transaction');
    }
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // connection already broken; surface the original error
      }
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/** Open a SQLite file (or `:memory:`) with Kitabu's required pragmas. */
export function openNodeSqlite(path: string): SqlitePort {
  const db = new NodeSqliteAdapter(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}
