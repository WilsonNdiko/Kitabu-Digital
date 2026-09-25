/**
 * SqlitePort — the single seam between the core and platform SQLite engines
 * (ADR-002 / ADR-011). Implementations: Node (`node:sqlite`), Electron
 * (better-sqlite3 + SQLCipher), React Native (quick-sqlite / op-sqlite).
 *
 * Contract notes:
 * - Values are null/number/bigint/string/Uint8Array. Booleans are NOT valid SQLite
 *   values — the CRUD layer normalizes them to 0/1 (docs/DATABASE.md §1).
 * - `transaction` is `BEGIN IMMEDIATE` based and must not be nested.
 */

export type SqliteValue = null | number | bigint | string | Uint8Array;

export interface SqliteStatement {
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
}

export interface SqlitePort {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Typed read helpers used across services. */
export function getRow<T>(db: SqlitePort, sql: string, params: SqliteValue[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function allRows<T>(db: SqlitePort, sql: string, params: SqliteValue[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}
