/**
 * @kitabu/core/node — Node.js entry: the `node:sqlite` adapter plus convenience
 * openers. Used by tests, CI, tooling, and the future server-side workers.
 * (Electron ships its own adapter; React Native never imports this entry.)
 */

import { NodeSqliteAdapter, openNodeSqlite } from './db/nodeSqliteAdapter.ts';
import type { SqlitePort } from './db/port.ts';
import { Kitabu } from './kitabu.ts';
import type { KitabuOptions } from './kitabu.ts';

export { NodeSqliteAdapter, openNodeSqlite };
export type { SqlitePort };

/** In-memory Kitabu (tests / throwaway sessions). */
export function openKitabuInMemory(options: Omit<KitabuOptions, 'sqlite'> = {}): Kitabu {
  return Kitabu.open({ ...options, sqlite: openNodeSqlite(':memory:') });
}

/** File-backed Kitabu (the real local database of a device). */
export function openKitabuFile(path: string, options: Omit<KitabuOptions, 'sqlite'> = {}): Kitabu {
  return Kitabu.open({ ...options, sqlite: openNodeSqlite(path) });
}
