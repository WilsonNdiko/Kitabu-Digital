import { newId, normalizeKenyanPhone } from '@kitabu/core';
import { AppError, audit, insertRow, updateRow, type Ctx } from '../db/index.js';

// ---------- properties & units ----------
export function createProperty(ctx: Ctx, input: { name: string; location?: string }) {
  if (!input.name?.trim()) throw new AppError('Please enter a property name.');
  const id = newId('prop');
  ctx.db.transaction(() => {
    insertRow(ctx, 'properties', {
      id, org_id: ctx.orgId, name: input.name.trim(), location: input.location?.trim() || null, notes: null,
    });
    audit(ctx, 'property.created', 'properties', id, undefined, input);
  })();
  return { id };
}

export function addUnits(
  ctx: Ctx,
  propertyId: string,
  units: { label: string; rentMinor: number; depositMinor?: number }[],
) {
  const prop = ctx.db.prepare('SELECT id FROM properties WHERE id = ? AND org_id = ?').get(propertyId, ctx.orgId);
  if (!prop) throw new AppError('Property not found.', 404);
  if (!units.length) throw new AppError('Add at least one house.');
  const ids: string[] = [];
  ctx.db.transaction(() => {
    for (const u of units) {
      if (!u.label?.trim()) throw new AppError('Every house needs a name/number.');
      if (!Number.isInteger(u.rentMinor) || u.rentMinor < 0) throw new AppError(`Enter a valid rent for ${u.label}.`);
      const id = newId('unit');
      try {
        insertRow(ctx, 'units', {
          id, org_id: ctx.orgId, property_id: propertyId, building_id: null,
          label: u.label.trim(), monthly_rent_minor: u.rentMinor, deposit_minor: u.depositMinor ?? 0, status: 'VACANT',
        });
      } catch (e: any) {
        if (String(e.message).includes('UNIQUE')) throw new AppError(`A house called "${u.label}" already exists in this property.`);
        throw e;
      }
      ids.push(id);
    }
    audit(ctx, 'units.added', 'properties', propertyId, undefined, { count: units.length });
  })();
  return { ids };
}

// ---------- tenants & tenancies ----------
export interface NewTenantInput {
  fullName: string;
  phone?: string;
  altPhone?: string;
  idNumber?: string;
  email?: string;
  notes?: string;
  moveIn?: { unitId: string; rentMinor?: number; depositMinor?: number; startDate: string; expectedPayDay?: number };
}

export function createTenant(ctx: Ctx, input: NewTenantInput) {
  if (!input.fullName?.trim()) throw new AppError('Please enter the tenant\u2019s name.');
  let phone: string | null = null;
  if (input.phone?.trim()) {
    phone = normalizeKenyanPhone(input.phone);
    if (!phone) throw new AppError('That phone number does not look right. Use 07xx xxx xxx or +2547xx xxx xxx.');
  }
  const tenantId = newId('ten');
  let tenancyId: string | null = null;
  ctx.db.transaction(() => {
    insertRow(ctx, 'tenants', {
      id: tenantId, org_id: ctx.orgId, full_name: input.fullName.trim(), phone,
      alt_phone: input.altPhone?.trim() || null, id_number: input.idNumber?.trim() || null,
      email: input.email?.trim() || null, emergency_name: null, emergency_phone: null,
      notes: input.notes?.trim() || null,
    });
    audit(ctx, 'tenant.created', 'tenants', tenantId, undefined, { name: input.fullName });
    if (input.moveIn) tenancyId = moveIn(ctx, tenantId, input.moveIn).id;
  })();
  return { id: tenantId, tenancyId };
}

export function moveIn(
  ctx: Ctx,
  tenantId: string,
  input: { unitId: string; rentMinor?: number; depositMinor?: number; startDate: string; expectedPayDay?: number },
) {
  const unit = ctx.db.prepare('SELECT * FROM units WHERE id = ? AND org_id = ?').get(input.unitId, ctx.orgId) as any;
  if (!unit) throw new AppError('House not found.', 404);
  const existing = ctx.db.prepare("SELECT t.id FROM tenancies t WHERE t.unit_id = ? AND t.status = 'ACTIVE'").get(input.unitId);
  if (existing) throw new AppError('This house already has a tenant. End that tenancy first.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new AppError('Enter a valid move-in date.');

  const rent = input.rentMinor ?? unit.monthly_rent_minor;
  const id = newId('tcy');
  const run = () => {
    insertRow(ctx, 'tenancies', {
      id, org_id: ctx.orgId, tenant_id: tenantId, unit_id: input.unitId, property_id: unit.property_id,
      rent_minor: rent, deposit_minor: input.depositMinor ?? unit.deposit_minor ?? 0,
      start_date: input.startDate, end_date: null, expected_pay_day: input.expectedPayDay ?? 5, status: 'ACTIVE',
    });
    insertRow(ctx, 'rent_rates', {
      id: newId('rate'), org_id: ctx.orgId, tenancy_id: id,
      rent_minor: rent, effective_from: input.startDate,
    });
    updateRow(ctx, 'units', input.unitId, { status: 'OCCUPIED' });
    audit(ctx, 'tenant.moved_in', 'tenancies', id, undefined, { tenantId, unitId: input.unitId, rent });
  };
  if (ctx.db.inTransaction) run(); else ctx.db.transaction(run)();
  return { id };
}

/** Move-out: tenancy ends but ALL history (ledger, payments, receipts) remains. */
export function endTenancy(ctx: Ctx, tenancyId: string, endDate: string) {
  const t = ctx.db.prepare('SELECT * FROM tenancies WHERE id = ? AND org_id = ?').get(tenancyId, ctx.orgId) as any;
  if (!t) throw new AppError('Tenancy not found.', 404);
  if (t.status === 'ENDED') throw new AppError('This tenancy has already ended.');
  ctx.db.transaction(() => {
    updateRow(ctx, 'tenancies', tenancyId, { status: 'ENDED', end_date: endDate });
    updateRow(ctx, 'units', t.unit_id, { status: 'VACANT' });
    audit(ctx, 'tenant.moved_out', 'tenancies', tenancyId, { status: t.status }, { status: 'ENDED', endDate });
  })();
}
