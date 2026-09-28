/**
 * Thin adapter over Node's built-in `node:sqlite` exposing the minimal API
 * our repositories use (prepare/run/get/all, exec, transaction, inTransaction).
 * In the packaged apps the same interface is backed by better-sqlite3 (Tauri
 * sidecar) or @capacitor-community/sqlite (Android) — services don't care.
 */
import { createRequire } from 'node:module';

// Loaded via require() at runtime: `node:sqlite` is newer than the builtin
// list some bundlers ship, and this keeps them from trying to resolve it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
type DatabaseSync = any;

export interface Stmt {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export class Db {
  private db: DatabaseSync;
  private txDepth = 0;
  /** File path of this database (':memory:' for tests) — used by backup. */
  readonly path: string;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.path = path;
  }

  /** Flush the WAL into the main file so the file on disk is complete. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(p: string): void {
    this.db.exec(`PRAGMA ${p};`);
  }

  prepare(sql: string): Stmt {
    const stmt = this.db.prepare(sql);
    const normalize = (params: unknown[]) => {
      // support a single trailing object of named params, else positional
      if (params.length === 1 && params[0] !== null && typeof params[0] === 'object') {
        return [sanitize(params[0] as Record<string, unknown>)];
      }
      return params.map((p) => (p === undefined ? null : p));
    };
    return {
      run: (...params: unknown[]) => stmt.run(...(normalize(params) as any[])) as { changes: number | bigint },
      get: (...params: unknown[]) => stmt.get(...(normalize(params) as any[])),
      all: (...params: unknown[]) => stmt.all(...(normalize(params) as any[])),
    };
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /** better-sqlite3-style transaction wrapper with graceful nesting. */
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const self = this;
    return function (this: unknown, ...args: unknown[]) {
      if (self.txDepth > 0) {
        self.txDepth++;
        try { return fn.apply(this, args); } finally { self.txDepth--; }
      }
      self.db.exec('BEGIN IMMEDIATE');
      self.txDepth = 1;
      try {
        const out = fn.apply(this, args);
        self.db.exec('COMMIT');
        return out;
      } catch (e) {
        try { self.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally {
        self.txDepth = 0;
      }
    } as T;
  }
}

function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? null : v;
  return out;
}
