/**
 * Mutation plumbing — the invariant that makes sync possible (ARCHITECTURE.md §8-1):
 *
 *   EVERY mutation = one transaction = data row + op-log entry + audit entry.
 *
 * Services call `stampNew` / `stampUpdate` to fill sync columns, write the row with
 * crud helpers, then `recordOp` (+ `appendAudit`). All of it must run inside
 * `db.transaction(...)`.
 */

import type { ServiceContext } from './context.ts';
import type { TableName } from '../db/crud.ts';
import { insertRow, setSetting } from '../db/crud.ts';
import type { SyncColumns } from '../domain/types.ts';
import { Hlc } from '../foundation/hlc.ts';
import { uuidv7, UlidFactory } from '../foundation/ids.ts';

const changeIds = new UlidFactory();

/** Change id (ULID — monotonic, sortable; the global sync dedupe key). */
export function newChangeId(): string {
  return changeIds.next();
}

/** Fill sync columns for a brand-new row (caller supplies id + org-scoped fields). */
export function stampNew(ctx: ServiceContext): SyncColumns {
  const hlc = ctx.hlcClock.now();
  const nowIso = ctx.clock.nowIso();
  return {
    id: uuidv7(),
    org_id: ctx.orgId,
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
    version: 1,
    hlc: hlc.encoded,
    origin_device_id: ctx.deviceId,
  };
}

/** Bump sync columns on an existing row object (mutates it). */
export function stampUpdate(ctx: ServiceContext, row: SyncColumns): void {
  const hlc = ctx.hlcClock.now();
  row.version += 1;
  row.updated_at = ctx.clock.nowIso();
  row.hlc = hlc.encoded;
}

/** Append an op to the device's change log (must run in the same transaction). */
export function recordOp(
  ctx: ServiceContext,
  table: TableName,
  row: SyncColumns,
  op: 'UPSERT' | 'DELETE' = 'UPSERT',
): void {
  const payloadJson = JSON.stringify(row);
  ctx.db
    .prepare(
      `INSERT INTO change_log
         (change_id, org_id, table_name, row_id, op, payload_json, row_version, hlc, origin_device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newChangeId(),
      ctx.orgId,
      table,
      row.id,
      op,
      payloadJson,
      row.version,
      row.hlc,
      row.origin_device_id,
      ctx.clock.nowIso(),
    );
  // Persist the HLC watermark so restarts can never regress ordering (docs/RISKS.md R8).
  const previous = lastHlc(ctx);
  const candidate = Hlc.decode(row.hlc);
  const next = previous === null ? candidate : Hlc.max(candidate, Hlc.decode(previous));
  setSetting(ctx.db, 'last_hlc', next.encoded);
}

function lastHlc(ctx: ServiceContext): string | null {
  const row = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'last_hlc'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/** Append to the audit log — itself a synced row that goes through the op-log. */
export function appendAudit(ctx: ServiceContext, entry: AuditEntry): void {
  const stamp = stampNew(ctx);
  const auditRow = {
    ...stamp,
    occurred_at: ctx.clock.nowIso(),
    actor_user_id: ctx.userId,
    actor_device_id: ctx.deviceId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    summary: entry.summary,
    before_json: entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    after_json: entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
  };
  insertRow(ctx.db, 'audit_log', auditRow);
  recordOp(ctx, 'audit_log', auditRow);
}
