/**
 * Sync engine v1 (docs/SYNC.md) — change-log exchange with idempotent apply.
 *
 * Principles implemented here:
 *  - ships CHANGES, never the whole database
 *  - any change may arrive multiple times via multiple paths → dedup by change_id
 *  - relayed changes keep their original change_id (multi-path convergence)
 *  - per-entity conflict policies; financial rows are immutable events
 *  - deterministic winners so every device converges to the SAME state
 */
import { AppError, nowIso, type Ctx, type DB } from '../db/index.js';

export const SYNCED_TABLES = [
  'organizations', 'users', 'properties', 'units', 'tenants', 'tenancies',
  'rent_rates', 'ledger_entries', 'payments', 'receipts', 'expenses',
  'maintenance_requests', 'devices', 'signatures', 'mpesa_statement_lines',
] as const;
const SYNCED = new Set<string>(SYNCED_TABLES);

/** Ledger entries are append-only immutable events: same id ⇒ same content. */
const IMMUTABLE = new Set(['ledger_entries']);

/** Payment status merge priority (docs/SYNC.md §5): later never downgrades. */
const STATUS_PRIORITY: Record<string, number> = {
  PENDING: 0, VERIFYING: 1, VERIFIED: 2, REJECTED: 3, REVERSED: 4,
};

export interface SyncChange {
  seq: number;
  change_id: string;
  org_id: string;
  entity_type: string;
  entity_id: string;
  op: 'UPSERT' | 'DELETE';
  payload_json: string;
  hlc: string;
  origin_device_id: string;
  created_at: string;
}

export interface ApplyResult { applied: number; skipped: number; conflicts: number }

export const SYNC_BATCH = 500;

export function getChangesSince(db: DB, afterSeq: number, limit = SYNC_BATCH): SyncChange[] {
  return db.prepare(
    'SELECT seq, change_id, org_id, entity_type, entity_id, op, payload_json, hlc, origin_device_id, created_at FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?',
  ).all(afterSeq, limit) as SyncChange[];
}

export function maxSeq(db: DB): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq),0) m FROM change_log').get() as any;
  return r.m as number;
}

function upsertRaw(db: DB, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(row);
}

/** Record a foreign change locally, KEEPING its original identity (relay-safe). */
function recordForeignChange(db: DB, c: SyncChange): void {
  db.prepare(
    `INSERT OR IGNORE INTO change_log(change_id, org_id, entity_type, entity_id, op, payload_json, hlc, origin_device_id, synced_to_cloud, created_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`,
  ).run(c.change_id, c.org_id, c.entity_type, c.entity_id, c.op, c.payload_json, c.hlc, c.origin_device_id, c.created_at);
  db.prepare('INSERT OR IGNORE INTO applied_changes(change_id, applied_at) VALUES (?,?)').run(c.change_id, nowIso());
}

function lwwWins(incoming: any, local: any, incomingDevice: string): boolean {
  if ((incoming.version ?? 0) !== (local.version ?? 0)) return (incoming.version ?? 0) > (local.version ?? 0);
  if ((incoming.updated_at ?? '') !== (local.updated_at ?? '')) return (incoming.updated_at ?? '') > (local.updated_at ?? '');
  // full tie: deterministic device-id tie-break so both sides pick the same winner
  return incomingDevice > (local.origin_device_id ?? '');
}

/**
 * Apply a batch of changes from a peer/cloud. Idempotent: re-delivery of any
 * change (same change_id) is skipped; conflicting rows resolve deterministically.
 */
export function applyChanges(ctx: Ctx, changes: SyncChange[]): ApplyResult {
  const res: ApplyResult = { applied: 0, skipped: 0, conflicts: 0 };
  const { db } = ctx;

  const tx = db.transaction(() => {
    for (const c of changes) {
      // organization isolation at the sync layer (§48.11)
      if (c.org_id !== ctx.orgId) { res.conflicts++; continue; }
      if (!SYNCED.has(c.entity_type)) { res.skipped++; continue; }

      // dedup across paths: seen it before (applied, or it's our own change echoed back)
      const seen = db.prepare('SELECT 1 FROM applied_changes WHERE change_id = ?').get(c.change_id)
        || db.prepare('SELECT 1 FROM change_log WHERE change_id = ?').get(c.change_id);
      if (seen) { res.skipped++; continue; }

      const incoming = JSON.parse(c.payload_json);
      const local = db.prepare(`SELECT * FROM ${c.entity_type} WHERE id = ?`).get(c.entity_id);

      let write = false;
      if (!local) {
        write = true;
      } else if (IMMUTABLE.has(c.entity_type)) {
        write = false; // same id ⇒ same immutable content
      } else if (c.entity_type === 'payments') {
        const pi = STATUS_PRIORITY[incoming.status] ?? 0;
        const pl = STATUS_PRIORITY[(local as any).status] ?? 0;
        write = pi > pl || (pi === pl && lwwWins(incoming, local, c.origin_device_id));
      } else if (c.entity_type === 'receipts') {
        write = false; // same receipt id already present — immutable
      } else {
        write = lwwWins(incoming, local, c.origin_device_id);
      }

      if (!write) { recordForeignChange(db, c); res.skipped++; continue; }

      try {
        if (c.entity_type === 'receipts') applyReceipt(ctx, incoming, c);
        else if (c.entity_type === 'tenancies') applyTenancy(ctx, incoming, c);
        else upsertRaw(db, c.entity_type, incoming);
        recordForeignChange(db, c);
        res.applied++;
      } catch (e: any) {
        // constraint conflict that needs deterministic resolution failed → park it
        recordForeignChange(db, c);
        res.conflicts++;
        console.error(`[sync] conflict applying ${c.entity_type}/${c.entity_id}: ${e.message}`);
      }
    }
    reconcilePayments(ctx);
  });
  tx();
  return res;
}

/**
 * Receipt issuance race (two devices issued for one payment):
 * deterministic winner = LOWER receipt id (earlier HLC). The loser is voided
 * on every device — like a spoiled page in a paper receipt book (docs/SYNC.md §5).
 */
function applyReceipt(ctx: Ctx, incoming: any, c: SyncChange): void {
  const { db } = ctx;
  const existing = db.prepare('SELECT * FROM receipts WHERE payment_id = ?').get(incoming.payment_id) as any;
  if (!existing) { upsertRaw(db, 'receipts', incoming); return; }
  if (existing.id === incoming.id) return;
  if (incoming.id < existing.id) {
    db.prepare('DELETE FROM receipts WHERE id = ?').run(existing.id);
    upsertRaw(db, 'receipts', incoming);
    auditSync(ctx, 'receipt.superseded', existing.id, `Duplicate receipt for one payment after sync; ${incoming.receipt_no} (earlier) kept, ${existing.receipt_no} voided.`);
  } else {
    auditSync(ctx, 'receipt.duplicate_ignored', incoming.id, `Receipt ${incoming.receipt_no} voided: ${existing.receipt_no} was issued earlier for the same payment.`);
  }
}

/**
 * Double move-in race (two devices moved different tenants into one unit
 * while offline): deterministic winner = lower tenancy id; the loser tenancy
 * is parked as ENDED for owner review — no silent double-occupancy, no data loss.
 */
function applyTenancy(ctx: Ctx, incoming: any, c: SyncChange): void {
  const { db } = ctx;
  if (incoming.status === 'ACTIVE') {
    const clash = db.prepare(
      "SELECT * FROM tenancies WHERE unit_id = ? AND status = 'ACTIVE' AND id != ?",
    ).get(incoming.unit_id, incoming.id) as any;
    if (clash) {
      if (incoming.id < clash.id) {
        db.prepare("UPDATE tenancies SET status='ENDED', end_date = COALESCE(end_date, start_date), version = version + 1, updated_at = ? WHERE id = ?")
          .run(nowIso(), clash.id);
        auditSync(ctx, 'tenancy.conflict', clash.id, 'Two move-ins for one house happened on different devices. The earlier one was kept — please review.');
      } else {
        incoming = { ...incoming, status: 'ENDED', end_date: incoming.end_date ?? incoming.start_date };
        auditSync(ctx, 'tenancy.conflict', incoming.id, 'Two move-ins for one house happened on different devices. The earlier one was kept — please review.');
      }
    }
  }
  upsertRaw(db, 'tenancies', incoming);
}

/**
 * Post-apply reconciliation keeps money consistent no matter which device the
 * status change came from (deterministic ledger ids make this idempotent):
 *  - VERIFIED payment missing its PAYMENT entry → post it
 *  - REJECTED/REVERSED payment whose PAYMENT entry lacks a REVERSAL → reverse it
 */
export function reconcilePayments(ctx: Ctx): void {
  const { db } = ctx;
  const missing = db.prepare(
    `SELECT p.* FROM payments p WHERE p.org_id = ? AND p.status = 'VERIFIED'
      AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.payment_id = p.id AND le.entry_type = 'PAYMENT')`,
  ).all(ctx.orgId) as any[];
  for (const p of missing) {
    insertLedgerIfAbsent(ctx, {
      id: `led_pay_${p.id.replace(/^pay_/, '')}`, tenancy_id: p.tenancy_id,
      entry_type: 'PAYMENT', amount_minor: -p.amount_minor, period: p.payment_date.slice(0, 7),
      effective_date: p.payment_date, payment_id: p.id, reverses_entry_id: null,
      memo: null, created_by: 'sync',
    });
  }
  const dangling = db.prepare(
    `SELECT p.*, le.id entry_id, le.amount_minor entry_amount, le.period entry_period
       FROM payments p JOIN ledger_entries le ON le.payment_id = p.id AND le.entry_type = 'PAYMENT'
      WHERE p.org_id = ? AND p.status IN ('REJECTED','REVERSED')
        AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.payment_id = p.id AND r.entry_type = 'REVERSAL')`,
  ).all(ctx.orgId) as any[];
  for (const p of dangling) {
    insertLedgerIfAbsent(ctx, {
      id: `led_rev_${p.id.replace(/^pay_/, '')}`, tenancy_id: p.tenancy_id,
      entry_type: 'REVERSAL', amount_minor: -p.entry_amount, period: p.entry_period,
      effective_date: nowIso().slice(0, 10), payment_id: p.id, reverses_entry_id: p.entry_id,
      memo: `Automatic correction after sync (payment ${p.status.toLowerCase()})`, created_by: 'sync',
    });
  }
}

function insertLedgerIfAbsent(ctx: Ctx, e: Record<string, unknown>): void {
  const { db } = ctx;
  const row: Record<string, unknown> = {
    ...e, org_id: ctx.orgId, version: 1, updated_at: nowIso(), deleted_at: null,
    origin_device_id: ctx.deviceId,
  };
  const cols = Object.keys(row);
  const r = db.prepare(`INSERT OR IGNORE INTO ledger_entries (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(row);
  if (Number(r.changes) > 0) {
    db.prepare(
      `INSERT OR IGNORE INTO change_log(change_id, org_id, entity_type, entity_id, op, payload_json, hlc, origin_device_id, synced_to_cloud, created_at)
       VALUES (?,?,?,?,?,?,?,?,0,?)`,
    ).run(`chg_recon_${row.id}`, ctx.orgId, 'ledger_entries', String(row.id), 'UPSERT', JSON.stringify(row),
      `${String(Date.now()).padStart(14, '0')}-0000-recon`, ctx.deviceId, nowIso());
  }
}

function auditSync(ctx: Ctx, action: string, entityId: string, note: string): void {
  ctx.db.prepare(
    `INSERT INTO audit_log(id, org_id, actor_user_id, device_id, action, entity_type, entity_id, before_json, after_json, at)
     VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
  ).run(`aud_sync_${Math.random().toString(36).slice(2)}${Date.now()}`, ctx.orgId, 'sync', ctx.deviceId,
    action, 'sync', entityId, JSON.stringify({ note }), nowIso());
}

/** Cursor helpers (per-peer progress; only ever moves forward). */
export function getPeerCursor(db: DB, peerDeviceId: string): number {
  const r = db.prepare('SELECT last_seq_received FROM sync_peers WHERE device_id = ?').get(peerDeviceId) as any;
  return r?.last_seq_received ?? 0;
}

export function advancePeerCursor(db: DB, peerDeviceId: string, seq: number, name?: string, address?: string): void {
  db.prepare(
    `INSERT INTO sync_peers(device_id, last_seq_received, last_sync_at, peer_name, peer_address)
     VALUES (?,?,?,?,?)
     ON CONFLICT(device_id) DO UPDATE SET
       last_seq_received = MAX(sync_peers.last_seq_received, excluded.last_seq_received),
       last_sync_at = excluded.last_sync_at,
       peer_name = COALESCE(excluded.peer_name, sync_peers.peer_name),
       peer_address = COALESCE(excluded.peer_address, sync_peers.peer_address)`,
  ).run(peerDeviceId, seq, nowIso(), name ?? null, address ?? null);
}

/** A revoked device must not sync (docs/SECURITY.md §4). */
export function assertDeviceAllowed(db: DB, deviceId: string): void {
  const d = db.prepare('SELECT status FROM devices WHERE id = ?').get(deviceId) as any;
  if (!d) throw new AppError('This device is not paired with this Kitabu.', 403);
  if (d.status !== 'ACTIVE') throw new AppError('This device has been revoked and can no longer sync.', 403);
}
