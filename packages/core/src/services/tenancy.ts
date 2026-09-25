/**
 * Tenancy service — dated occupancy, the historical record (brief §12).
 *
 * A tenant is never permanently attached to a unit: tenancies are dated rows.
 * Moving house = end one tenancy + start another, atomically, with history intact.
 * Rent is effective-dated (`rent_rates`) and append-only — changing rent never
 * rewrites history (brief §48-5/6, FINANCIAL-LEDGER.md §3).
 */

import type { ServiceContext } from './context.ts';
import { requireRole } from './context.ts';
import { appendAudit, recordOp, stampNew, stampUpdate } from './mutations.ts';
import { insertRow, updateRow } from '../db/crud.ts';
import type { RentRateRow, TenancyRow, TenantRow, UnitRow } from '../domain/types.ts';
import { isValidIsoDate } from '../foundation/clock.ts';
import { domainRule, notFound, validationError } from '../foundation/errors.ts';

export interface StartTenancyInput {
  tenantId: string;
  unitId: string;
  /** Rent in minor units (cents). Must be > 0. */
  rentMinor: number;
  depositMinor?: number;
  /** Move-in date, `YYYY-MM-DD`. */
  startDate: string;
  /** Day of month rent is due (1–28; Kenyan default: 5th). */
  expectedPaymentDay?: number;
  notes?: string;
}

export interface TenancyHistoryEntry extends TenancyRow {
  unit_label: string;
  property_name: string;
  tenant_name: string;
}

export class TenancyService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  // -- reads -----------------------------------------------------------------

  getTenancy(id: string): TenancyRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM tenancies WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as TenancyRow | undefined;
    if (row === undefined) throw notFound('Tenancy not found.');
    return row;
  }

  activeTenancyForUnit(unitId: string): TenancyRow | null {
    const row = this.ctx.db
      .prepare("SELECT * FROM tenancies WHERE unit_id = ? AND org_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL")
      .get(unitId, this.ctx.orgId) as TenancyRow | undefined;
    return row ?? null;
  }

  activeTenancyForTenant(tenantId: string): TenancyRow | null {
    const row = this.ctx.db
      .prepare("SELECT * FROM tenancies WHERE tenant_id = ? AND org_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL")
      .get(tenantId, this.ctx.orgId) as TenancyRow | undefined;
    return row ?? null;
  }

  /** Full occupancy history for a tenant — oldest first. Moves never destroy rows. */
  tenancyHistory(tenantId: string): TenancyHistoryEntry[] {
    return this.ctx.db
      .prepare(
        `SELECT t.*, u.label AS unit_label, p.name AS property_name, te.full_name AS tenant_name
         FROM tenancies t
         JOIN units u ON u.id = t.unit_id
         JOIN properties p ON p.id = t.property_id
         JOIN tenants te ON te.id = t.tenant_id
         WHERE t.tenant_id = ? AND t.org_id = ? AND t.deleted_at IS NULL
         ORDER BY t.start_date ASC, t.created_at ASC`,
      )
      .all(tenantId, this.ctx.orgId) as TenancyHistoryEntry[];
  }

  /** Rent in effect for a tenancy on a given date (latest effective_from <= date). */
  rentOn(tenancyId: string, date: string): RentRateRow | null {
    const row = this.ctx.db
      .prepare(
        `SELECT * FROM rent_rates
         WHERE tenancy_id = ? AND deleted_at IS NULL AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(tenancyId, date) as RentRateRow | undefined;
    return row ?? null;
  }

  rentRates(tenancyId: string): RentRateRow[] {
    return this.ctx.db
      .prepare(
        'SELECT * FROM rent_rates WHERE tenancy_id = ? AND deleted_at IS NULL ORDER BY effective_from ASC',
      )
      .all(tenancyId) as RentRateRow[];
  }

  // -- writes ------------------------------------------------------------------

  startTenancy(input: StartTenancyInput): TenancyRow {
    requireRole(this.ctx, ['OWNER'], 'move a tenant into a house');
    return this.ctx.db.transaction(() => this.#startTenancyTx(input));
  }

  /**
   * Internal start (assumes an open transaction) — also used by moveTenant.
   * Validations throw friendly DOMAIN_RULE/VALIDATION errors (docs/UX.md §5).
   */
  #startTenancyTx(input: StartTenancyInput): TenancyRow {
    if (!isValidIsoDate(input.startDate)) {
      throw validationError('The move-in date is not a valid date.');
    }
    if (!Number.isSafeInteger(input.rentMinor) || input.rentMinor <= 0) {
      throw validationError('Enter the monthly rent as a positive amount.');
    }
    const depositMinor = input.depositMinor ?? 0;
    if (!Number.isSafeInteger(depositMinor) || depositMinor < 0) {
      throw validationError('The deposit cannot be negative.');
    }
    const expectedPaymentDay = input.expectedPaymentDay ?? 5;
    if (!Number.isInteger(expectedPaymentDay) || expectedPaymentDay < 1 || expectedPaymentDay > 28) {
      throw validationError('The rent due day must be between 1 and 28.');
    }

    const tenant = this.#tenant(input.tenantId);
    const unit = this.#unit(input.unitId);

    if (this.activeTenancyForUnit(unit.id) !== null) {
      throw domainRule(`House ${unit.label} already has a tenant. End their tenancy first.`);
    }

    // Tenancy row
    const stamp = stampNew(this.ctx);
    const tenancy: TenancyRow = {
      ...stamp,
      tenant_id: tenant.id,
      unit_id: unit.id,
      property_id: unit.property_id,
      start_date: input.startDate,
      end_date: null,
      end_reason: null,
      expected_payment_day: expectedPaymentDay,
      deposit_amount_minor: depositMinor,
      deposit_paid: 0,
      current_rent_minor: input.rentMinor,
      status: 'ACTIVE',
      notes: input.notes?.trim() || null,
    };
    insertRow(this.ctx.db, 'tenancies', tenancy);
    recordOp(this.ctx, 'tenancies', tenancy);

    // Initial effective-dated rent rate (append-only history from day one)
    const rateStamp = stampNew(this.ctx);
    const rate: RentRateRow = {
      ...rateStamp,
      tenancy_id: tenancy.id,
      effective_from: input.startDate,
      amount_minor: input.rentMinor,
      reason: 'Initial rent',
      created_by_user_id: this.ctx.userId,
    };
    insertRow(this.ctx.db, 'rent_rates', rate);
    recordOp(this.ctx, 'rent_rates', rate);

    // Unit becomes occupied (status is derived from tenancies — kept consistent here)
    const beforeUnit = { ...unit };
    stampUpdate(this.ctx, unit);
    unit.status = 'OCCUPIED';
    updateRow(this.ctx.db, 'units', unit);
    recordOp(this.ctx, 'units', unit);

    appendAudit(this.ctx, {
      action: 'TENANCY_STARTED',
      entityType: 'tenancy',
      entityId: tenancy.id,
      summary: `${tenant.full_name} moved into house ${unit.label}.`,
      before: null,
      after: { tenancy: { ...tenancy }, unitBefore: beforeUnit, unitAfter: { ...unit } },
    });
    return tenancy;
  }

  endTenancy(tenancyId: string, endDate: string, reason?: string): TenancyRow {
    requireRole(this.ctx, ['OWNER'], 'end a tenancy');
    return this.ctx.db.transaction(() => this.#endTenancyTx(tenancyId, endDate, reason ?? 'Tenancy ended'));
  }

  #endTenancyTx(tenancyId: string, endDate: string, reason: string): TenancyRow {
    if (!isValidIsoDate(endDate)) throw validationError('The move-out date is not a valid date.');
    const tenancy = this.getTenancy(tenancyId);
    if (tenancy.status !== 'ACTIVE') {
      throw domainRule('This tenancy has already ended.');
    }
    if (endDate < tenancy.start_date) {
      throw domainError('move-out date');
    }

    const tenant = this.#tenant(tenancy.tenant_id);
    const unit = this.#unit(tenancy.unit_id);

    const before = { ...tenancy };
    stampUpdate(this.ctx, tenancy);
    tenancy.end_date = endDate;
    tenancy.end_reason = reason.trim() === '' ? 'Tenancy ended' : reason.trim();
    tenancy.status = 'ENDED';
    updateRow(this.ctx.db, 'tenancies', tenancy);
    recordOp(this.ctx, 'tenancies', tenancy);

    if (unit.status === 'OCCUPIED') {
      stampUpdate(this.ctx, unit);
      unit.status = 'VACANT';
      updateRow(this.ctx.db, 'units', unit);
      recordOp(this.ctx, 'units', unit);
    }

    appendAudit(this.ctx, {
      action: 'TENANCY_ENDED',
      entityType: 'tenancy',
      entityId: tenancy.id,
      summary: `${tenant.full_name} moved out of house ${unit.label} (${tenancy.end_reason}).`,
      before,
      after: { ...tenancy },
    });
    return tenancy;
  }

  /**
   * Move a tenant to another house — atomic end + start. The previous tenancy row
   * and its rent history remain untouched (brief §12 example).
   */
  moveTenant(tenancyId: string, toUnitId: string, opts: {
    date: string;
    newRentMinor?: number;
    newDepositMinor?: number;
    reason?: string;
  }): { ended: TenancyRow; started: TenancyRow } {
    requireRole(this.ctx, ['OWNER'], 'move a tenant to another house');
    if (!isValidIsoDate(opts.date)) throw validationError('The move date is not a valid date.');

    return this.ctx.db.transaction(() => {
      const current = this.getTenancy(tenancyId);
      if (current.status !== 'ACTIVE') throw domainRule('Only an active tenancy can move house.');
      if (toUnitId === current.unit_id) {
        throw domainRule('The tenant already lives in this house.');
      }

      const ended = this.#endTenancyTx(tenancyId, opts.date, opts.reason?.trim() || 'Moved to another house');
      const fromLabel = this.#unit(current.unit_id).label;
      const started = this.#startTenancyTx({
        tenantId: current.tenant_id,
        unitId: toUnitId,
        rentMinor: opts.newRentMinor ?? current.current_rent_minor,
        depositMinor: opts.newDepositMinor ?? current.deposit_amount_minor,
        startDate: opts.date,
        expectedPaymentDay: current.expected_payment_day,
        notes: `Moved from house ${fromLabel}`,
      });
      appendAudit(this.ctx, {
        action: 'TENANCY_MOVED',
        entityType: 'tenant',
        entityId: current.tenant_id,
        summary: `${this.#tenant(current.tenant_id).full_name} moved from house ${fromLabel} to house ${this.#unit(toUnitId).label}.`,
        before: { endedTenancy: { ...ended } },
        after: { startedTenancy: { ...started } },
      });
      return { ended, started };
    });
  }

  /**
   * Change rent — appends an effective-dated rate. Existing charges keep their
   * amounts forever; the tenancy's current rent updates only when the new rate is
   * in effect (FINANCIAL-LEDGER.md §3).
   */
  changeRent(tenancyId: string, newRentMinor: number, effectiveFrom: string, reason?: string): RentRateRow {
    requireRole(this.ctx, ['OWNER'], 'change the rent');
    if (!isValidIsoDate(effectiveFrom)) throw validationError('The effective date is not a valid date.');
    if (!Number.isSafeInteger(newRentMinor) || newRentMinor <= 0) {
      throw validationError('Enter the new rent as a positive amount.');
    }

    return this.ctx.db.transaction(() => {
      const tenancy = this.getTenancy(tenancyId);
      if (tenancy.status !== 'ACTIVE') throw domainRule('Rent can only change on an active tenancy.');
      if (effectiveFrom < tenancy.start_date) {
        throw domainRule('The new rent cannot start before the tenant moved in.');
      }

      // Rates are append-only. Inserting at any point in the timeline is allowed
      // (retroactive agreements), but a date can only ever have one rate.
      const duplicateRate = this.ctx.db
        .prepare('SELECT effective_from FROM rent_rates WHERE tenancy_id = ? AND effective_from = ? AND deleted_at IS NULL')
        .get(tenancy.id, effectiveFrom) as { effective_from: string } | undefined;
      if (duplicateRate !== undefined) {
        throw domainRule(`A rent rate already exists for ${effectiveFrom}. Pick a different effective date.`);
      }

      const tenant = this.#tenant(tenancy.tenant_id);
      const stamp = stampNew(this.ctx);
      const rate: RentRateRow = {
        ...stamp,
        tenancy_id: tenancy.id,
        effective_from: effectiveFrom,
        amount_minor: newRentMinor,
        reason: reason?.trim() || null,
        created_by_user_id: this.ctx.userId,
      };
      insertRow(this.ctx.db, 'rent_rates', rate);
      recordOp(this.ctx, 'rent_rates', rate);

      // Denormalized current rent updates only when the new rate takes effect now.
      const today = this.ctx.clock.today();
      if (effectiveFrom <= today && tenancy.current_rent_minor !== newRentMinor) {
        const before = { ...tenancy };
        stampUpdate(this.ctx, tenancy);
        tenancy.current_rent_minor = newRentMinor;
        updateRow(this.ctx.db, 'tenancies', tenancy);
        recordOp(this.ctx, 'tenancies', tenancy);
        appendAudit(this.ctx, {
          action: 'RENT_CHANGED',
          entityType: 'tenancy',
          entityId: tenancy.id,
          summary: `Rent for ${tenant.full_name} changed to KSh ${(newRentMinor / 100).toLocaleString('en-US')} from ${effectiveFrom}.`,
          before,
          after: { ...tenancy },
        });
      } else {
        appendAudit(this.ctx, {
          action: 'RENT_SCHEDULED',
          entityType: 'tenancy',
          entityId: tenancy.id,
          summary: `Future rent change scheduled for ${effectiveFrom} for ${tenant.full_name}.`,
          after: { ...rate },
        });
      }
      return rate;
    });
  }

  // -- internal loaders ---------------------------------------------------------

  #tenant(id: string): TenantRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as TenantRow | undefined;
    if (row === undefined) throw notFound('Tenant not found.');
    return row;
  }

  #unit(id: string): UnitRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM units WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as UnitRow | undefined;
    if (row === undefined) throw notFound('House not found.');
    return row;
  }
}

// Small helper used by endTenancy above.
function domainError(what: string): Error {
  return validationError(`The ${what} cannot be before the move-in date.`);
}
