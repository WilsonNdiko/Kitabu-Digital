/**
 * Typed CRUD helpers over SqlitePort.
 *
 * - INSERT/UPDATE are built from the typed row object passed by services.
 * - Booleans are normalized to 0/1 (SQLite has no boolean; docs/DATABASE.md §1).
 * - `undefined` values are rejected loudly (be explicit: null or a value).
 * - Table names are whitelisted (SYNCED_TABLES) — no dynamic SQL from outside.
 */

import type { SqlitePort, SqliteValue } from './port.ts';
import { KitabuError } from '../foundation/errors.ts';

export const SYNCED_TABLES = [
  'organizations',
  'devices',
  'users',
  'properties',
  'buildings',
  'units',
  'tenants',
  'tenancies',
  'rent_rates',
  'audit_log',
  'payments',
  'ledger_entries',
  'payment_allocations',
  'receipts',
  'signature_images',
  'receipt_number_blocks',
  'org_keys',
] as const;

export type TableName = (typeof SYNCED_TABLES)[number];

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

function assertKnownTable(table: TableName): void {
  if (!(SYNCED_TABLES as readonly string[]).includes(table)) {
    throw new KitabuError('STORAGE', 'Internal error: unknown table', `table=${table}`);
  }
}

function normalizeValue(table: string, column: string, value: unknown): SqliteValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) {
    throw new KitabuError('STORAGE', 'Internal error: incomplete record', `${table}.${column} was undefined`);
  }
  if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) {
    return value;
  }
  throw new KitabuError('STORAGE', 'Internal error: unsupported value', `${table}.${column}=${String(value)}`);
}

export function insertRow(db: SqlitePort, table: TableName, row: object): void {
  assertKnownTable(table);
  const entries = Object.entries(row).filter(([k]) => k !== 'seq');
  const cols = entries.map(([k]) => k);
  for (const c of cols) {
    if (!IDENTIFIER_RE.test(c)) throw new KitabuError('STORAGE', 'Internal error: bad column', `${table}.${c}`);
  }
  const params = entries.map(([k, v]) => normalizeValue(table, k, v));
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...params);
}

/** Full-row UPDATE by id. Throws NOT_FOUND if the row disappeared. */
export function updateRow(db: SqlitePort, table: TableName, row: object & { id: string }): void {
  assertKnownTable(table);
  const entries = Object.entries(row).filter(([k]) => k !== 'id' && k !== 'seq');
  const cols = entries.map(([k]) => k);
  for (const c of cols) {
    if (!IDENTIFIER_RE.test(c)) throw new KitabuError('STORAGE', 'Internal error: bad column', `${table}.${c}`);
  }
  const params = entries.map(([k, v]) => normalizeValue(table, k, v));
  params.push(row.id);
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...params);
  if (Number(result.changes) === 0) {
    throw new KitabuError('NOT_FOUND', 'This record no longer exists.', `${table} ${row.id} update matched 0 rows`);
  }
}

export function setting(db: SqlitePort, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return (row as { value: string } | undefined)?.value ?? null;
}

export function setSetting(db: SqlitePort, key: string, value: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
