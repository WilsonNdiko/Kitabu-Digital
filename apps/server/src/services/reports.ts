import { periodOf } from '@kitabu/core';
import { todayIso, type Ctx } from '../db/index.js';
import { ensureCharges } from './finance.js';
import { monthStatus } from './queries.js';

/** Rent collection per property for a month: expected / collected / rate. */
export function collectionReport(ctx: Ctx, period?: string) {
  ensureCharges(ctx);
  const p = period || periodOf(todayIso());
  const rows = monthStatus(ctx, p);
  const byProp = new Map<string, any>();
  for (const r of rows) {
    const b = byProp.get(r.propertyId) ?? {
      propertyId: r.propertyId, propertyName: r.propertyName,
      tenancies: 0, expectedMinor: 0, collectedMinor: 0,
    };
    b.tenancies += 1;
    b.expectedMinor += r.chargedMinor;
    b.collectedMinor += r.paidMinor;
    byProp.set(r.propertyId, b);
  }
  const props = [...byProp.values()].map((b) => ({
    ...b,
    outstandingMinor: Math.max(0, b.expectedMinor - b.collectedMinor),
    ratePct: b.expectedMinor > 0 ? Math.round((b.collectedMinor / b.expectedMinor) * 100) : 100,
  }));
  const total = props.reduce(
    (t, b) => ({
      expectedMinor: t.expectedMinor + b.expectedMinor,
      collectedMinor: t.collectedMinor + b.collectedMinor,
      outstandingMinor: t.outstandingMinor + b.outstandingMinor,
    }),
    { expectedMinor: 0, collectedMinor: 0, outstandingMinor: 0 },
  );
  return {
    period: p,
    properties: props,
    total: { ...total, ratePct: total.expectedMinor > 0 ? Math.round((total.collectedMinor / total.expectedMinor) * 100) : 100 },
    tenants: rows, // per-tenant detail for CSV export
  };
}

/** Expense totals by category (and by property) for a date range. */
export function expenseReport(ctx: Ctx, from?: string, to?: string) {
  const f = from || '0000-01-01';
  const t = to || '9999-12-31';
  const byCategory = ctx.db.prepare(
    `SELECT category, COUNT(*) count, SUM(amount_minor) totalMinor
       FROM expenses WHERE org_id = ? AND deleted_at IS NULL AND expense_date BETWEEN ? AND ?
      GROUP BY category ORDER BY totalMinor DESC`,
  ).all(ctx.orgId, f, t);
  const byProperty = ctx.db.prepare(
    `SELECT pr.name propertyName, COUNT(*) count, SUM(e.amount_minor) totalMinor
       FROM expenses e JOIN properties pr ON pr.id = e.property_id
      WHERE e.org_id = ? AND e.deleted_at IS NULL AND e.expense_date BETWEEN ? AND ?
      GROUP BY pr.id ORDER BY totalMinor DESC`,
  ).all(ctx.orgId, f, t);
  const total = ctx.db.prepare(
    'SELECT COALESCE(SUM(amount_minor),0) v FROM expenses WHERE org_id = ? AND deleted_at IS NULL AND expense_date BETWEEN ? AND ?',
  ).get(ctx.orgId, f, t) as any;
  return { from: f, to: t, byCategory, byProperty, totalMinor: total.v };
}

/** Occupancy per property. */
export function occupancyReport(ctx: Ctx) {
  return ctx.db.prepare(
    `SELECT pr.id propertyId, pr.name propertyName,
            COUNT(u.id) units,
            SUM(CASE WHEN u.status='OCCUPIED' THEN 1 ELSE 0 END) occupied,
            SUM(CASE WHEN u.status='VACANT' THEN 1 ELSE 0 END) vacant,
            SUM(CASE WHEN u.status='MAINTENANCE' THEN 1 ELSE 0 END) maintenance
       FROM properties pr LEFT JOIN units u ON u.property_id = pr.id AND u.deleted_at IS NULL
      WHERE pr.org_id = ? AND pr.deleted_at IS NULL
      GROUP BY pr.id ORDER BY pr.name`,
  ).all(ctx.orgId);
}
