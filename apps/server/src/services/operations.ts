import { newId } from '@kitabu/core';
import { AppError, audit, insertRow, nowIso, todayIso, updateRow, type Ctx } from '../db/index.js';

export const EXPENSE_CATEGORIES = [
  'Repairs', 'Plumbing', 'Electricity', 'Water', 'Garbage', 'Security',
  'Cleaning', 'Caretaker wages', 'Materials', 'Taxes & fees', 'Other',
] as const;

export function createExpense(ctx: Ctx, input: {
  propertyId: string; category: string; amountMinor: number; method?: string;
  reference?: string; expenseDate?: string; description?: string;
}) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new AppError('Enter a valid amount.');
  if (!input.category?.trim()) throw new AppError('Choose a category.');
  const prop = ctx.db.prepare('SELECT id FROM properties WHERE id=? AND org_id=?').get(input.propertyId, ctx.orgId);
  if (!prop) throw new AppError('Property not found.', 404);
  const id = newId('exp');
  ctx.db.transaction(() => {
    insertRow(ctx, 'expenses', {
      id, org_id: ctx.orgId, property_id: input.propertyId, category: input.category.trim(),
      amount_minor: input.amountMinor, method: input.method || 'CASH', reference: input.reference?.trim() || null,
      expense_date: input.expenseDate || todayIso(), description: input.description?.trim() || null,
      recorded_by: ctx.userId,
    });
    audit(ctx, 'expense.created', 'expenses', id, undefined, { category: input.category, amount: input.amountMinor });
  })();
  return { id };
}

export function listExpenses(ctx: Ctx, propertyId?: string) {
  return ctx.db.prepare(
    `SELECT e.*, pr.name property_name FROM expenses e JOIN properties pr ON pr.id = e.property_id
      WHERE e.org_id = ? AND e.deleted_at IS NULL ${propertyId ? 'AND e.property_id = ?' : ''}
      ORDER BY e.expense_date DESC LIMIT 200`,
  ).all(...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId]));
}

const MAINT_FLOW: Record<string, string[]> = {
  REPORTED: ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'],
  ASSIGNED: ['IN_PROGRESS', 'COMPLETED', 'REPORTED'],
  IN_PROGRESS: ['COMPLETED', 'ASSIGNED'],
  COMPLETED: [],
};

export function createMaintenance(ctx: Ctx, input: {
  propertyId: string; unitId?: string; tenantId?: string; title: string;
  description?: string; priority?: 'LOW' | 'MEDIUM' | 'HIGH';
}) {
  if (!input.title?.trim()) throw new AppError('Describe the issue briefly (e.g. "Blocked drain, House A-3").');
  const prop = ctx.db.prepare('SELECT id FROM properties WHERE id=? AND org_id=?').get(input.propertyId, ctx.orgId);
  if (!prop) throw new AppError('Property not found.', 404);
  const id = newId('mnt');
  ctx.db.transaction(() => {
    insertRow(ctx, 'maintenance_requests', {
      id, org_id: ctx.orgId, property_id: input.propertyId, unit_id: input.unitId || null,
      tenant_id: input.tenantId || null, title: input.title.trim(), description: input.description?.trim() || null,
      priority: input.priority || 'MEDIUM', status: 'REPORTED', assigned_to: null, cost_minor: null,
      reported_at: nowIso(), completed_at: null, notes: null,
    });
    audit(ctx, 'maintenance.reported', 'maintenance_requests', id, undefined, { title: input.title });
  })();
  return { id };
}

export function updateMaintenanceStatus(ctx: Ctx, id: string, input: {
  status: string; assignedTo?: string; costMinor?: number; notes?: string;
}) {
  const m = ctx.db.prepare('SELECT * FROM maintenance_requests WHERE id=? AND org_id=?').get(id, ctx.orgId) as any;
  if (!m) throw new AppError('Maintenance issue not found.', 404);
  if (!MAINT_FLOW[m.status]?.includes(input.status)) {
    throw new AppError(`This issue is ${m.status.toLowerCase().replace('_', ' ')} and cannot move to ${input.status.toLowerCase().replace('_', ' ')}.`);
  }
  ctx.db.transaction(() => {
    updateRow(ctx, 'maintenance_requests', id, {
      status: input.status,
      assigned_to: input.assignedTo ?? m.assigned_to,
      cost_minor: input.costMinor ?? m.cost_minor,
      notes: input.notes ?? m.notes,
      completed_at: input.status === 'COMPLETED' ? nowIso() : m.completed_at,
    });
    audit(ctx, 'maintenance.updated', 'maintenance_requests', id, { status: m.status }, { status: input.status });
  })();
}

export function listMaintenance(ctx: Ctx, openOnly = false) {
  return ctx.db.prepare(
    `SELECT m.*, pr.name property_name, u.label unit_label, tn.full_name tenant_name
       FROM maintenance_requests m
       JOIN properties pr ON pr.id = m.property_id
       LEFT JOIN units u ON u.id = m.unit_id
       LEFT JOIN tenants tn ON tn.id = m.tenant_id
      WHERE m.org_id = ? AND m.deleted_at IS NULL ${openOnly ? "AND m.status != 'COMPLETED'" : ''}
      ORDER BY m.reported_at DESC LIMIT 200`,
  ).all(ctx.orgId);
}
