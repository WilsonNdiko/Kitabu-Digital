import { buildStatement, periodOf, type LedgerEntry } from '@kitabu/core';
import { todayIso, type Ctx } from '../db/index.js';
import { ensureCharges, tenancyBalance } from './finance.js';

const currentPeriod = () => periodOf(todayIso());

// -------------------------------------------------------------- dashboard --
export function dashboard(ctx: Ctx) {
  ensureCharges(ctx);
  const db = ctx.db;
  const period = currentPeriod();

  const props = db.prepare('SELECT COUNT(*) c FROM properties WHERE org_id = ? AND deleted_at IS NULL').get(ctx.orgId) as any;
  const units = db.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN status='OCCUPIED' THEN 1 ELSE 0 END) occupied,
            SUM(CASE WHEN status='VACANT' THEN 1 ELSE 0 END) vacant
       FROM units WHERE org_id = ? AND deleted_at IS NULL`,
  ).get(ctx.orgId) as any;

  const expected = db.prepare(
    "SELECT COALESCE(SUM(amount_minor),0) v FROM ledger_entries WHERE org_id=? AND entry_type='CHARGE' AND period=?",
  ).get(ctx.orgId, period) as any;
  const collected = db.prepare(
    `SELECT COALESCE(SUM(amount_minor),0) v FROM payments
      WHERE org_id=? AND status='VERIFIED' AND substr(payment_date,1,7)=?`,
  ).get(ctx.orgId, period) as any;

  const perTenancy = monthStatus(ctx, period);
  const openMaint = db.prepare(
    "SELECT COUNT(*) c FROM maintenance_requests WHERE org_id=? AND status != 'COMPLETED' AND deleted_at IS NULL",
  ).get(ctx.orgId) as any;
  const pendingPayments = db.prepare(
    "SELECT COUNT(*) c FROM payments WHERE org_id=? AND status IN ('PENDING','VERIFYING')",
  ).get(ctx.orgId) as any;
  const outstanding = perTenancy.reduce((s, r) => s + Math.max(0, r.balanceMinor), 0);

  return {
    period,
    properties: props.c, units: units.total ?? 0, occupied: units.occupied ?? 0, vacant: units.vacant ?? 0,
    expectedMinor: expected.v, collectedMinor: collected.v, outstandingMinor: outstanding,
    tenants: {
      paid: perTenancy.filter((r) => r.monthStatus === 'PAID').length,
      partial: perTenancy.filter((r) => r.monthStatus === 'PARTIAL').length,
      overdue: perTenancy.filter((r) => r.monthStatus === 'OVERDUE').length,
    },
    openMaintenance: openMaint.c,
    pendingVerification: pendingPayments.c,
  };
}

// ---------------------------------------------------------------- arrears --
export interface TenancyMonthRow {
  tenancyId: string; tenantId: string; tenantName: string; phone: string | null;
  unitLabel: string; propertyId: string; propertyName: string;
  rentMinor: number; chargedMinor: number; paidMinor: number; balanceMinor: number;
  monthStatus: 'PAID' | 'PARTIAL' | 'OVERDUE' | 'CREDIT';
}

export function monthStatus(ctx: Ctx, period: string, propertyId?: string): TenancyMonthRow[] {
  const rows = ctx.db.prepare(
    `SELECT tc.id tenancy_id, tc.rent_minor, tn.id tenant_id, tn.full_name, tn.phone,
            u.label unit_label, pr.id property_id, pr.name property_name
       FROM tenancies tc
       JOIN tenants tn ON tn.id = tc.tenant_id
       JOIN units u ON u.id = tc.unit_id
       JOIN properties pr ON pr.id = tc.property_id
      WHERE tc.org_id = ? AND tc.status='ACTIVE' AND tc.deleted_at IS NULL
        ${propertyId ? 'AND pr.id = ?' : ''}
      ORDER BY pr.name, u.label`,
  ).all(...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId])) as any[];

  return rows.map((r) => {
    const charged = (ctx.db.prepare(
      "SELECT COALESCE(SUM(amount_minor),0) v FROM ledger_entries WHERE tenancy_id=? AND entry_type='CHARGE' AND period=?",
    ).get(r.tenancy_id, period) as any).v as number;
    const paid = (ctx.db.prepare(
      `SELECT COALESCE(SUM(amount_minor),0) v FROM payments
        WHERE tenancy_id=? AND status='VERIFIED' AND substr(payment_date,1,7)=?`,
    ).get(r.tenancy_id, period) as any).v as number;
    const balance = tenancyBalance(ctx, r.tenancy_id);
    let ms: TenancyMonthRow['monthStatus'];
    if (balance <= 0) ms = balance < 0 ? 'CREDIT' : 'PAID';
    else if (paid > 0) ms = 'PARTIAL';
    else ms = 'OVERDUE';
    return {
      tenancyId: r.tenancy_id, tenantId: r.tenant_id, tenantName: r.full_name, phone: r.phone,
      unitLabel: r.unit_label, propertyId: r.property_id, propertyName: r.property_name,
      rentMinor: r.rent_minor, chargedMinor: charged, paidMinor: paid, balanceMinor: balance, monthStatus: ms,
    };
  });
}

export function arrears(ctx: Ctx, opts: { propertyId?: string; period?: string }) {
  ensureCharges(ctx);
  const period = opts.period || currentPeriod();
  const rows = monthStatus(ctx, period, opts.propertyId);
  return {
    period,
    rows: rows.filter((r) => r.balanceMinor > 0),
    totalArrearsMinor: rows.reduce((s, r) => s + Math.max(0, r.balanceMinor), 0),
  };
}

// ----------------------------------------------------------------- lists --
export function listProperties(ctx: Ctx) {
  return ctx.db.prepare(
    `SELECT pr.*, 
            (SELECT COUNT(*) FROM units u WHERE u.property_id = pr.id AND u.deleted_at IS NULL) units,
            (SELECT COUNT(*) FROM units u WHERE u.property_id = pr.id AND u.status='OCCUPIED' AND u.deleted_at IS NULL) occupied
       FROM properties pr WHERE pr.org_id = ? AND pr.deleted_at IS NULL ORDER BY pr.name`,
  ).all(ctx.orgId);
}

export function propertyDetail(ctx: Ctx, propertyId: string) {
  const prop = ctx.db.prepare('SELECT * FROM properties WHERE id=? AND org_id=?').get(propertyId, ctx.orgId);
  const units = ctx.db.prepare(
    `SELECT u.*, tc.id tenancy_id, tn.full_name tenant_name, tn.id tenant_id
       FROM units u
       LEFT JOIN tenancies tc ON tc.unit_id = u.id AND tc.status='ACTIVE'
       LEFT JOIN tenants tn ON tn.id = tc.tenant_id
      WHERE u.property_id = ? AND u.deleted_at IS NULL ORDER BY u.label`,
  ).all(propertyId);
  return { property: prop, units };
}

export function listTenants(ctx: Ctx, q?: string) {
  const like = q ? `%${q}%` : null;
  return ctx.db.prepare(
    `SELECT tn.*, tc.id tenancy_id, u.label unit_label, pr.name property_name, tc.rent_minor
       FROM tenants tn
       LEFT JOIN tenancies tc ON tc.tenant_id = tn.id AND tc.status='ACTIVE'
       LEFT JOIN units u ON u.id = tc.unit_id
       LEFT JOIN properties pr ON pr.id = tc.property_id
      WHERE tn.org_id = ? AND tn.deleted_at IS NULL
        ${like ? 'AND (tn.full_name LIKE ? OR tn.phone LIKE ? OR u.label LIKE ?)' : ''}
      ORDER BY tn.full_name`,
  ).all(...(like ? [ctx.orgId, like, like, like] : [ctx.orgId])) as any[];
}

export function tenantDetail(ctx: Ctx, tenantId: string) {
  ensureCharges(ctx);
  const tenant = ctx.db.prepare('SELECT * FROM tenants WHERE id=? AND org_id=?').get(tenantId, ctx.orgId) as any;
  if (!tenant) return null;
  const tenancies = ctx.db.prepare(
    `SELECT tc.*, u.label unit_label, pr.name property_name
       FROM tenancies tc JOIN units u ON u.id=tc.unit_id JOIN properties pr ON pr.id=tc.property_id
      WHERE tc.tenant_id = ? ORDER BY tc.start_date DESC`,
  ).all(tenantId) as any[];
  const active = tenancies.find((t) => t.status === 'ACTIVE');
  let statement: any[] = [];
  let balanceMinor = 0;
  if (active) {
    const entries = ctx.db.prepare(
      'SELECT * FROM ledger_entries WHERE tenancy_id = ? ORDER BY effective_date, id',
    ).all(active.id) as any[];
    const mapped: LedgerEntry[] = entries.map((e) => ({
      id: e.id, tenancyId: e.tenancy_id, entryType: e.entry_type, amountMinor: e.amount_minor,
      period: e.period, effectiveDate: e.effective_date, paymentId: e.payment_id,
      reversesEntryId: e.reverses_entry_id, memo: e.memo,
    }));
    statement = buildStatement(mapped);
    balanceMinor = tenancyBalance(ctx, active.id);
  }
  const payments = ctx.db.prepare(
    `SELECT p.*, r.receipt_no, r.id receipt_id FROM payments p
       LEFT JOIN receipts r ON r.payment_id = p.id
      WHERE p.tenant_id = ? ORDER BY p.payment_date DESC, p.id DESC`,
  ).all(tenantId);
  return { tenant, tenancies, activeTenancy: active ?? null, balanceMinor, statement, payments };
}

export function listPayments(ctx: Ctx, status?: string) {
  return ctx.db.prepare(
    `SELECT p.*, tn.full_name tenant_name, u.label unit_label, pr.name property_name,
            r.receipt_no, r.id receipt_id
       FROM payments p
       JOIN tenants tn ON tn.id = p.tenant_id
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr ON pr.id = p.property_id
       LEFT JOIN receipts r ON r.payment_id = p.id
      WHERE p.org_id = ? ${status ? 'AND p.status = ?' : ''}
      ORDER BY p.payment_date DESC, p.id DESC LIMIT 200`,
  ).all(...(status ? [ctx.orgId, status] : [ctx.orgId]));
}

export function listReceipts(ctx: Ctx) {
  return (ctx.db.prepare(
    'SELECT id, receipt_no, payment_id, issued_at, snapshot_json FROM receipts WHERE org_id = ? ORDER BY issued_at DESC LIMIT 200',
  ).all(ctx.orgId) as any[]).map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot_json), snapshot_json: undefined }));
}

export function getReceipt(ctx: Ctx, id: string) {
  const r = ctx.db.prepare('SELECT * FROM receipts WHERE id = ? AND org_id = ?').get(id, ctx.orgId) as any;
  if (!r) return null;
  return { id: r.id, receiptNo: r.receipt_no, paymentId: r.payment_id, issuedAt: r.issued_at, snapshot: JSON.parse(r.snapshot_json) };
}

// ----------------------------------------------------------------- search --
export function search(ctx: Ctx, q: string) {
  const like = `%${q}%`;
  const tenants = ctx.db.prepare(
    `SELECT tn.id, tn.full_name, tn.phone, u.label unit_label FROM tenants tn
       LEFT JOIN tenancies tc ON tc.tenant_id = tn.id AND tc.status='ACTIVE'
       LEFT JOIN units u ON u.id = tc.unit_id
      WHERE tn.org_id=? AND tn.deleted_at IS NULL AND (tn.full_name LIKE ? OR tn.phone LIKE ? OR tn.id_number LIKE ?) LIMIT 10`,
  ).all(ctx.orgId, like, like, like);
  const payments = ctx.db.prepare(
    `SELECT p.id, p.amount_minor, p.method, p.reference, p.payment_date, p.status, tn.full_name tenant_name, u.label unit_label
       FROM payments p JOIN tenants tn ON tn.id=p.tenant_id JOIN units u ON u.id=p.unit_id
      WHERE p.org_id=? AND (p.reference LIKE ? OR tn.full_name LIKE ?) LIMIT 10`,
  ).all(ctx.orgId, like, like);
  const receipts = ctx.db.prepare(
    'SELECT id, receipt_no, payment_id FROM receipts WHERE org_id=? AND receipt_no LIKE ? LIMIT 10',
  ).all(ctx.orgId, like);
  const units = ctx.db.prepare(
    `SELECT u.id, u.label, u.status, pr.name property_name, pr.id property_id FROM units u JOIN properties pr ON pr.id=u.property_id
      WHERE u.org_id=? AND u.deleted_at IS NULL AND u.label LIKE ? LIMIT 10`,
  ).all(ctx.orgId, like);
  return { tenants, payments, receipts, units };
}

// ------------------------------------------------------------- sync/audit --
export function syncStatus(ctx: Ctx) {
  const pending = ctx.db.prepare('SELECT COUNT(*) c FROM change_log WHERE synced_to_cloud = 0').get() as any;
  const device = ctx.db.prepare('SELECT name, device_code FROM devices WHERE id = ?').get(ctx.deviceId) as any;
  return {
    pendingChanges: pending.c,
    device: { id: ctx.deviceId, code: ctx.deviceCode, name: device?.name ?? 'This device' },
    cloud: { connected: false, lastSyncAt: null },
    peers: [],
  };
}

export function listAudit(ctx: Ctx) {
  return ctx.db.prepare(
    `SELECT a.*, u.full_name actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.org_id = ? ORDER BY a.at DESC LIMIT 200`,
  ).all(ctx.orgId);
}
