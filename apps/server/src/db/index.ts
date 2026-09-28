import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, newDeviceCode, ulid } from '@kitabu/core';
import { Db } from './sqlite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

export type DB = Db;

/** Everything a service needs to act on behalf of this device+user. */
export interface Ctx {
  db: DB;
  orgId: string;
  userId: string;
  userRole: 'OWNER' | 'MANAGER' | 'CARETAKER';
  deviceId: string;
  deviceCode: string;
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Db(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // additive migrations for databases created before these columns existed
  for (const stmt of [
    'ALTER TABLE sync_peers ADD COLUMN peer_name TEXT',
    'ALTER TABLE sync_peers ADD COLUMN peer_address TEXT',
  ]) {
    try { db.exec(stmt); } catch { /* column already exists */ }
  }
  return db;
}

export const nowIso = (): string => new Date().toISOString();
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Friendly-message error the API layer maps to HTTP 4xx. */
export class AppError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// ---- settings -------------------------------------------------------------
export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

/** Ensure this installation has a device identity (created before any org). */
export function ensureDevice(db: DB): { deviceId: string; deviceCode: string } {
  let deviceId = getSetting(db, 'device_id');
  let deviceCode = getSetting(db, 'device_code');
  if (!deviceId || !deviceCode) {
    deviceId = newId('dev');
    deviceCode = newDeviceCode();
    setSetting(db, 'device_id', deviceId);
    setSetting(db, 'device_code', deviceCode);
  }
  return { deviceId, deviceCode };
}

// ---- generic row writes with change-log discipline -------------------------
// Every write to a synced table goes through these helpers so the change_log
// entry is appended in the same transaction (docs/SYNC.md §2). A simple HLC:
// physical ms + local counter + device id.
let hlcCounter = 0;
function nextHlc(deviceId: string): string {
  hlcCounter = (hlcCounter + 1) % 10000;
  return `${String(Date.now()).padStart(14, '0')}-${String(hlcCounter).padStart(4, '0')}-${deviceId.slice(-6)}`;
}

function logChange(ctx: Ctx, entityType: string, entityId: string, op: 'UPSERT' | 'DELETE', payload: unknown): void {
  ctx.db.prepare(
    `INSERT INTO change_log(change_id, org_id, entity_type, entity_id, op, payload_json, hlc, origin_device_id, synced_to_cloud, created_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`,
  ).run(`chg_${ulid()}`, ctx.orgId, entityType, entityId, op, JSON.stringify(payload), nextHlc(ctx.deviceId), ctx.deviceId, nowIso());
}

/** INSERT a full row object (keys = column names) + change log. */
export function insertRow(ctx: Ctx, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = {
    version: 1,
    updated_at: nowIso(),
    deleted_at: null,
    origin_device_id: ctx.deviceId,
    ...row,
  };
  const cols = Object.keys(full);
  ctx.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(full);
  logChange(ctx, table, String(full['id']), 'UPSERT', full);
}

/** INSERT OR IGNORE (for deterministic-id idempotent rows like rent charges). */
export function insertRowIfAbsent(ctx: Ctx, table: string, row: Record<string, unknown>): boolean {
  const full: Record<string, unknown> = { version: 1, updated_at: nowIso(), deleted_at: null, origin_device_id: ctx.deviceId, ...row };
  const cols = Object.keys(full);
  const res = ctx.db
    .prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`)
    .run(full);
  if (res.changes > 0) logChange(ctx, table, String(full['id']), 'UPSERT', full);
  return res.changes > 0;
}

/** UPDATE selected fields of a row by id, bumping version + change log. */
export function updateRow(ctx: Ctx, table: string, id: string, fields: Record<string, unknown>): void {
  const patch = { ...fields, updated_at: nowIso() };
  const sets = Object.keys(patch).map((c) => `${c} = @${c}`).join(', ');
  ctx.db.prepare(`UPDATE ${table} SET ${sets}, version = version + 1 WHERE id = @__id`).run({ ...patch, __id: id });
  const row = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  logChange(ctx, table, id, 'UPSERT', row);
}

/** Append an audit entry (same transaction as the action). */
export function audit(
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
): void {
  ctx.db.prepare(
    `INSERT INTO audit_log(id, org_id, actor_user_id, device_id, action, entity_type, entity_id, before_json, after_json, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId('aud'), ctx.orgId, ctx.userId, ctx.deviceId, action, entityType, entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    nowIso(),
  );
}
