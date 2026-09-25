/**
 * Tenant service — registration with minimal required fields (PRD FR-02),
 * guarded updates, and archive (soft delete) that preserves all history
 * (brief §12 / §48-7: deleting a tenant must never destroy financial history).
 */

import type { ServiceContext } from './context.ts';
import { appendAudit, recordOp, stampNew, stampUpdate } from './mutations.ts';
import { insertRow, updateRow } from '../db/crud.ts';
import type { SqliteValue } from '../db/port.ts';
import type { TenantRow } from '../domain/types.ts';
import { domainRule, notFound, validationError } from '../foundation/errors.ts';
import { normalizeKenyanMobile } from '../foundation/phone.ts';

function trimOrNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

function requireValidPhone(label: string, value: string | undefined | null): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const normalized = normalizeKenyanMobile(value);
  if (normalized === null) {
    throw validationError(`${label} does not look right. Use a Kenyan mobile like 0712 345 678.`);
  }
  return normalized;
}

export interface RegisterTenantInput {
  fullName: string;
  phone?: string;
  altPhone?: string;
  idNumber?: string;
  email?: string;
  emergencyContact?: string;
  notes?: string;
}

export class TenantService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  getTenant(id: string): TenantRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM tenants WHERE id = ? AND org_id = ?')
      .get(id, this.ctx.orgId) as TenantRow | undefined;
    if (row === undefined) throw notFound('Tenant not found.');
    return row;
  }

  listTenants(input: { search?: string; includeArchived?: boolean } = {}): TenantRow[] {
    const includeArchived = input.includeArchived ?? false;
    const search = input.search?.trim() ?? '';
    const deletedFilter = includeArchived ? '' : 'AND deleted_at IS NULL';
    if (search === '') {
      return this.ctx.db
        .prepare(
          `SELECT * FROM tenants WHERE org_id = ? ${deletedFilter}
           ORDER BY full_name COLLATE NOCASE`,
        )
        .all(this.ctx.orgId) as TenantRow[];
    }

    const escapeLike = (term: string): string => `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    // Phones are stored E.164 (+2547XXXXXXXX) but users type 07xx / 2547xx / 7xx —
    // search all sensible digit variants (Kenyan-context search, PRD §45).
    const primary = escapeLike(search);
    const patterns = new Set<string>([primary]);
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 7) {
      let national = digits;
      if (national.startsWith('254') && national.length === 12) national = national.slice(3);
      else if (national.startsWith('0')) national = national.slice(1);
      if (national.length === 9 && (national[0] === '7' || national[0] === '1')) {
        patterns.add(`%+254${national}%`);
      }
      patterns.add(`%${digits}%`);
    }

    const clauses: string[] = ['full_name LIKE ? ESCAPE \'\\\'', 'id_number LIKE ? ESCAPE \'\\\''];
    const params: SqliteValue[] = [primary, primary];
    for (const p of patterns) {
      clauses.push('phone LIKE ? ESCAPE \'\\\'');
      params.push(p);
    }
    for (const p of patterns) {
      clauses.push('alt_phone LIKE ? ESCAPE \'\\\'');
      params.push(p);
    }

    return this.ctx.db
      .prepare(
        `SELECT * FROM tenants
         WHERE org_id = ? ${deletedFilter}
           AND (${clauses.join(' OR ')})
         ORDER BY full_name COLLATE NOCASE`,
      )
      .all(this.ctx.orgId, ...params) as TenantRow[];
  }

  registerTenant(input: RegisterTenantInput): TenantRow {
    const fullName = input.fullName.trim().replace(/\s+/g, ' ');
    if (fullName === '') throw validationError('The tenant must have a name.');

    const phone = requireValidPhone('The tenant phone number', input.phone);
    const altPhone = requireValidPhone('The alternative phone number', input.altPhone);

    return this.ctx.db.transaction(() => {
      const stamp = stampNew(this.ctx);
      const row: TenantRow = {
        ...stamp,
        full_name: fullName,
        phone,
        alt_phone: altPhone,
        id_number: trimOrNull(input.idNumber),
        email: trimOrNull(input.email),
        emergency_contact: trimOrNull(input.emergencyContact),
        notes: trimOrNull(input.notes),
      };
      insertRow(this.ctx.db, 'tenants', row);
      recordOp(this.ctx, 'tenants', row);
      appendAudit(this.ctx, {
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: row.id,
        summary: `Tenant ${fullName} registered.`,
        after: { ...row },
      });
      return row;
    });
  }

  updateTenant(id: string, input: {
    fullName?: string;
    phone?: string | null;
    altPhone?: string | null;
    idNumber?: string | null;
    email?: string | null;
    emergencyContact?: string | null;
    notes?: string | null;
  }): TenantRow {
    return this.ctx.db.transaction(() => {
      const row = this.getTenant(id);
      const before = { ...row };

      if (input.fullName !== undefined) {
        const fullName = input.fullName.trim().replace(/\s+/g, ' ');
        if (fullName === '') throw validationError('The tenant must have a name.');
        row.full_name = fullName;
      }
      if (input.phone !== undefined) row.phone = requireValidPhone('The phone number', input.phone);
      if (input.altPhone !== undefined) row.alt_phone = requireValidPhone('The alternative phone number', input.altPhone);
      if (input.idNumber !== undefined) row.id_number = trimOrNull(input.idNumber);
      if (input.email !== undefined) row.email = trimOrNull(input.email);
      if (input.emergencyContact !== undefined) row.emergency_contact = trimOrNull(input.emergencyContact);
      if (input.notes !== undefined) row.notes = trimOrNull(input.notes);

      stampUpdate(this.ctx, row);
      updateRow(this.ctx.db, 'tenants', row);
      recordOp(this.ctx, 'tenants', row);
      appendAudit(this.ctx, {
        action: 'TENANT_UPDATED',
        entityType: 'tenant',
        entityId: row.id,
        summary: `Tenant ${row.full_name}'s details updated.`,
        before,
        after: { ...row },
      });
      return row;
    });
  }

  /**
   * Archive (soft-delete) a tenant. Never a hard delete: tenancy and financial
   * history stays intact and the tenant disappears from day-to-day lists.
   */
  archiveTenant(id: string, reason?: string): TenantRow {
    return this.ctx.db.transaction(() => {
      const row = this.getTenant(id);
      if (row.deleted_at !== null) return row;

      const active = this.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM tenancies WHERE tenant_id = ? AND org_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL")
        .get(id, this.ctx.orgId) as { n: number };
      if (active.n > 0) {
        throw domainRule('This tenant still lives in a house. End their tenancy before archiving them.');
      }

      const before = { ...row };
      stampUpdate(this.ctx, row);
      row.deleted_at = this.ctx.clock.nowIso();
      updateRow(this.ctx.db, 'tenants', row);
      recordOp(this.ctx, 'tenants', row);
      appendAudit(this.ctx, {
        action: 'TENANT_ARCHIVED',
        entityType: 'tenant',
        entityId: row.id,
        summary: `Tenant ${row.full_name} archived${reason ? ` (${reason.trim()})` : ''}. History is preserved.`,
        before,
        after: { ...row },
      });
      return row;
    });
  }
}
