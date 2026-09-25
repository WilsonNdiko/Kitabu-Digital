/**
 * Property service — properties, buildings, units (houses).
 *
 * Simple model for small landlords: a property may have buildings, or none —
 * units with `building_id = null` belong directly to the property. Unit status is
 * `VACANT`/`OCCUPIED` (kept consistent by the tenancy service) plus manual
 * `MAINTENANCE`/`RESERVED` flags for vacant units.
 */

import type { ServiceContext } from './context.ts';
import { requireRole } from './context.ts';
import { appendAudit, recordOp, stampNew, stampUpdate } from './mutations.ts';
import { insertRow, updateRow } from '../db/crud.ts';
import type { BuildingRow, PropertyRow, UnitKind, UnitRow, UnitStatus } from '../domain/types.ts';
import { UNIT_KINDS } from '../domain/types.ts';
import { domainRule, notFound, validationError } from '../foundation/errors.ts';

export interface PropertyWithCounts extends PropertyRow {
  unit_count: number;
  occupied_count: number;
}

export interface PropertySummary {
  property: PropertyRow;
  totalUnits: number;
  occupied: number;
  vacant: number;
  maintenance: number;
  reserved: number;
}

function trimOrNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

export class PropertyService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  // -- reads -----------------------------------------------------------------

  listProperties(): PropertyWithCounts[] {
    return this.ctx.db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.deleted_at IS NULL) AS unit_count,
                (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.deleted_at IS NULL AND u.status = 'OCCUPIED') AS occupied_count
         FROM properties p
         WHERE p.org_id = ? AND p.deleted_at IS NULL
         ORDER BY p.name COLLATE NOCASE`,
      )
      .all(this.ctx.orgId) as PropertyWithCounts[];
  }

  getProperty(id: string): PropertyRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM properties WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as PropertyRow | undefined;
    if (row === undefined) throw notFound('Property not found.');
    return row;
  }

  #getUnitInternal(id: string): UnitRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM units WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as UnitRow | undefined;
    if (row === undefined) throw notFound('House not found.');
    return row;
  }

  getUnit(id: string): UnitRow {
    return this.#getUnitInternal(id);
  }

  listUnits(propertyId: string): UnitRow[] {
    return this.ctx.db
      .prepare(
        `SELECT * FROM units
         WHERE property_id = ? AND org_id = ? AND deleted_at IS NULL
         ORDER BY label COLLATE NOCASE`,
      )
      .all(propertyId, this.ctx.orgId) as UnitRow[];
  }

  summary(propertyId: string): PropertySummary {
    const property = this.getProperty(propertyId);
    const rows = this.ctx.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM units
         WHERE property_id = ? AND org_id = ? AND deleted_at IS NULL
         GROUP BY status`,
      )
      .all(propertyId, this.ctx.orgId) as Array<{ status: UnitStatus; n: number }>;
    const by = new Map(rows.map((r) => [r.status, r.n]));
    return {
      property,
      totalUnits: rows.reduce((acc, r) => acc + r.n, 0),
      occupied: by.get('OCCUPIED') ?? 0,
      vacant: by.get('VACANT') ?? 0,
      maintenance: by.get('MAINTENANCE') ?? 0,
      reserved: by.get('RESERVED') ?? 0,
    };
  }

  listBuildings(propertyId: string): BuildingRow[] {
    return this.ctx.db
      .prepare(
        `SELECT * FROM buildings
         WHERE property_id = ? AND org_id = ? AND deleted_at IS NULL
         ORDER BY name COLLATE NOCASE`,
      )
      .all(propertyId, this.ctx.orgId) as BuildingRow[];
  }

  // -- writes ------------------------------------------------------------------

  createProperty(input: {
    name: string;
    town?: string;
    estate?: string;
    notes?: string;
  }): PropertyRow {
    requireRole(this.ctx, ['OWNER'], 'add a property');
    const name = input.name.trim();
    if (name === '') throw validationError('Give the property a name (for example "Green View Apartments").');

    return this.ctx.db.transaction(() => {
      const stamp = stampNew(this.ctx);
      const row: PropertyRow = {
        ...stamp,
        name,
        town: trimOrNull(input.town),
        estate: trimOrNull(input.estate),
        notes: trimOrNull(input.notes),
      };
      insertRow(this.ctx.db, 'properties', row);
      recordOp(this.ctx, 'properties', row);
      appendAudit(this.ctx, {
        action: 'PROPERTY_CREATED',
        entityType: 'property',
        entityId: row.id,
        summary: `Property "${name}" added.`,
        after: { ...row },
      });
      return row;
    });
  }

  updateProperty(id: string, input: {
    name?: string;
    town?: string | null;
    estate?: string | null;
    notes?: string | null;
  }): PropertyRow {
    requireRole(this.ctx, ['OWNER'], 'edit a property');
    return this.ctx.db.transaction(() => {
      const row = this.getProperty(id);
      const before = { ...row };
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (name === '') throw validationError('The property name cannot be empty.');
        row.name = name;
      }
      if (input.town !== undefined) row.town = trimOrNull(input.town);
      if (input.estate !== undefined) row.estate = trimOrNull(input.estate);
      if (input.notes !== undefined) row.notes = trimOrNull(input.notes);

      stampUpdate(this.ctx, row);
      updateRow(this.ctx.db, 'properties', row);
      recordOp(this.ctx, 'properties', row);
      appendAudit(this.ctx, {
        action: 'PROPERTY_UPDATED',
        entityType: 'property',
        entityId: row.id,
        summary: `Property "${row.name}" details updated.`,
        before,
        after: { ...row },
      });
      return row;
    });
  }

  /** Soft-delete a property — only when no unit has an active tenancy. */
  archiveProperty(id: string): PropertyRow {
    requireRole(this.ctx, ['OWNER'], 'archive a property');
    return this.ctx.db.transaction(() => {
      const row = this.getProperty(id);
      const active = this.ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tenancies t
           JOIN units u ON u.id = t.unit_id
           WHERE t.org_id = ? AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
             AND u.property_id = ? AND u.deleted_at IS NULL`,
        )
        .get(this.ctx.orgId, id) as { n: number };
      if (active.n > 0) {
        throw domainRule('You cannot archive a property while tenants still live in it. End their tenancies first.');
      }

      const before = { ...row };
      stampUpdate(this.ctx, row);
      row.deleted_at = this.ctx.clock.nowIso();
      updateRow(this.ctx.db, 'properties', row);
      recordOp(this.ctx, 'properties', row);

      // Soft-delete its live units and buildings in the same transaction.
      const units = this.listUnits(id);
      for (const unit of units) {
        stampUpdate(this.ctx, unit);
        unit.deleted_at = this.ctx.clock.nowIso();
        updateRow(this.ctx.db, 'units', unit);
        recordOp(this.ctx, 'units', unit);
      }
      const buildings = this.listBuildings(id);
      for (const b of buildings) {
        stampUpdate(this.ctx, b);
        b.deleted_at = this.ctx.clock.nowIso();
        updateRow(this.ctx.db, 'buildings', b);
        recordOp(this.ctx, 'buildings', b);
      }

      appendAudit(this.ctx, {
        action: 'PROPERTY_ARCHIVED',
        entityType: 'property',
        entityId: row.id,
        summary: `Property "${row.name}" archived (with ${units.length} houses).`,
        before,
        after: { ...row },
      });
      return row;
    });
  }

  addBuilding(input: { propertyId: string; name: string; notes?: string }): BuildingRow {
    requireRole(this.ctx, ['OWNER'], 'add a building');
    const name = input.name.trim();
    if (name === '') throw validationError('Give the building a name (for example "Block A").');
    return this.ctx.db.transaction(() => {
      const property = this.getProperty(input.propertyId);
      const stamp = stampNew(this.ctx);
      const row: BuildingRow = {
        ...stamp,
        property_id: property.id,
        name,
        notes: trimOrNull(input.notes),
      };
      insertRow(this.ctx.db, 'buildings', row);
      recordOp(this.ctx, 'buildings', row);
      appendAudit(this.ctx, {
        action: 'BUILDING_CREATED',
        entityType: 'building',
        entityId: row.id,
        summary: `Building "${name}" added to ${property.name}.`,
        after: { ...row },
      });
      return row;
    });
  }

  addUnit(input: {
    propertyId: string;
    buildingId?: string;
    label: string;
    kind?: UnitKind;
    notes?: string;
  }): UnitRow {
    requireRole(this.ctx, ['OWNER'], 'add a house');
    const label = input.label.trim();
    if (label === '') throw validationError('Give the house a number or name (for example "A-12").');
    const kind: UnitKind = input.kind ?? 'HOUSE';
    if (!UNIT_KINDS.includes(kind)) throw validationError('Unknown house type.');

    return this.ctx.db.transaction(() => {
      const property = this.getProperty(input.propertyId);

      let buildingId: string | null = null;
      if (input.buildingId !== undefined && input.buildingId !== null) {
        const building = this.ctx.db
          .prepare('SELECT * FROM buildings WHERE id = ? AND property_id = ? AND deleted_at IS NULL')
          .get(input.buildingId, property.id) as BuildingRow | undefined;
        if (building === undefined) throw notFound('Building not found in this property.');
        buildingId = building.id;
      }

      const duplicate = this.ctx.db
        .prepare('SELECT id FROM units WHERE property_id = ? AND label = ? AND deleted_at IS NULL')
        .get(property.id, label) as { id: string } | undefined;
      if (duplicate !== undefined) {
        throw domainRule(`A house called "${label}" already exists in ${property.name}.`);
      }

      const stamp = stampNew(this.ctx);
      const row: UnitRow = {
        ...stamp,
        property_id: property.id,
        building_id: buildingId,
        label,
        kind,
        status: 'VACANT',
        notes: trimOrNull(input.notes),
      };
      insertRow(this.ctx.db, 'units', row);
      recordOp(this.ctx, 'units', row);
      appendAudit(this.ctx, {
        action: 'UNIT_CREATED',
        entityType: 'unit',
        entityId: row.id,
        summary: `House "${label}" added to ${property.name}.`,
        after: { ...row },
      });
      return row;
    });
  }

  updateUnit(id: string, input: {
    label?: string;
    kind?: UnitKind;
    notes?: string | null;
  }): UnitRow {
    requireRole(this.ctx, ['OWNER'], 'edit a house');
    return this.ctx.db.transaction(() => {
      const row = this.#getUnitInternal(id);
      const before = { ...row };
      if (input.label !== undefined) {
        const label = input.label.trim();
        if (label === '') throw validationError('The house number cannot be empty.');
        const duplicate = this.ctx.db
          .prepare('SELECT id FROM units WHERE property_id = ? AND label = ? AND deleted_at IS NULL AND id != ?')
          .get(row.property_id, label, row.id) as { id: string } | undefined;
        if (duplicate !== undefined) throw domainRule(`A house called "${label}" already exists in this property.`);
        row.label = label;
      }
      if (input.kind !== undefined) {
        if (!UNIT_KINDS.includes(input.kind)) throw validationError('Unknown house type.');
        row.kind = input.kind;
      }
      if (input.notes !== undefined) row.notes = trimOrNull(input.notes);

      stampUpdate(this.ctx, row);
      updateRow(this.ctx.db, 'units', row);
      recordOp(this.ctx, 'units', row);
      appendAudit(this.ctx, {
        action: 'UNIT_UPDATED',
        entityType: 'unit',
        entityId: row.id,
        summary: `House "${row.label}" updated.`,
        before,
        after: { ...row },
      });
      return row;
    });
  }

  /** Flag/unflag a VACANT unit as under maintenance. Occupied units must be vacated first. */
  setUnitMaintenance(id: string, on: boolean): UnitRow {
    requireRole(this.ctx, ['OWNER'], 'mark a house as under maintenance');
    return this.ctx.db.transaction(() => {
      const row = this.#getUnitInternal(id);
      if (on && row.status === 'OCCUPIED') {
        throw domainRule('A tenant still lives in this house. End the tenancy before marking maintenance.');
      }
      if (row.status === (on ? 'MAINTENANCE' : 'VACANT')) return row;

      const before = { ...row };
      stampUpdate(this.ctx, row);
      row.status = on ? 'MAINTENANCE' : 'VACANT';
      updateRow(this.ctx.db, 'units', row);
      recordOp(this.ctx, 'units', row);
      appendAudit(this.ctx, {
        action: 'UNIT_STATUS_CHANGED',
        entityType: 'unit',
        entityId: row.id,
        summary: `House "${row.label}" marked ${on ? 'under maintenance' : 'available again'}.`,
        before,
        after: { ...row },
      });
      return row;
    });
  }
}
