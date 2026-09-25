/**
 * Organization service — first-run bootstrap and organization settings.
 *
 * Bootstrap creates, in ONE transaction: organization + this device + the owner user,
 * each with op-log entries and audit entries, plus the local app settings. This is the
 * root of trust for a Level-1 (single device) installation (docs/ARCHITECTURE.md §4).
 */

import type { ServiceContext } from './context.ts';
import { appendAudit, recordOp, stampNew, stampUpdate } from './mutations.ts';
import { insertRow, setSetting, updateRow } from '../db/crud.ts';
import type { DevicePlatform, DeviceRow, OrganizationRow, UserRow } from '../domain/types.ts';
import type { Clock } from '../foundation/clock.ts';
import { HybridLogicalClock } from '../foundation/hlc.ts';
import { uuidv7 } from '../foundation/ids.ts';
import { domainRule, validationError } from '../foundation/errors.ts';
import { normalizeKenyanMobile } from '../foundation/phone.ts';
import type { SqlitePort } from '../db/port.ts';

export interface BootstrapInput {
  organizationName: string;
  landlordName?: string;
  phone?: string;
  kraPin?: string;
  /** What the landlord calls a rental unit (default 'House'). */
  unitTerm?: string;
  deviceName: string;
  platform: DevicePlatform;
}

export interface BootstrapResult {
  ctx: ServiceContext;
  organization: OrganizationRow;
  device: DeviceRow;
  owner: UserRow;
}

const UNIT_TERM_OPTIONS = ['House', 'Unit', 'Room', 'Apartment'];

function trimOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * Create the local organization. Runs against a fresh (migrated) database; throws
 * DOMAIN_RULE if an organization already exists in it.
 */
export function bootstrapOrganization(db: SqlitePort, clock: Clock, input: BootstrapInput): BootstrapResult {
  const orgName = input.organizationName.trim();
  if (orgName === '') {
    throw validationError('Give your organization a name (for example "Wilson Properties").');
  }
  const deviceName = input.deviceName.trim();
  if (deviceName === '') {
    throw validationError('Give this device a name (for example "Jane\'s Phone").');
  }

  let phone: string | null = null;
  if (input.phone !== undefined && input.phone.trim() !== '') {
    phone = normalizeKenyanMobile(input.phone);
    if (phone === null) throw validationError('That phone number does not look right. Use a Kenyan mobile like 0712 345 678.');
  }

  const unitTerm = input.unitTerm?.trim() || 'House';
  if (!UNIT_TERM_OPTIONS.includes(unitTerm)) {
    throw validationError('Choose House, Unit, Room or Apartment as your word for a rental.');
  }

  const orgId = uuidv7();
  const deviceId = uuidv7();
  const ownerId = uuidv7();
  const hlcClock = new HybridLogicalClock(deviceId, clock);

  const ctx: ServiceContext = {
    db,
    clock,
    hlcClock,
    deviceId,
    orgId,
    userId: ownerId,
  };

  return db.transaction(() => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number };
    if (existing.n > 0) {
      throw domainRule('This phone already has a Kitabu organization. Open Settings to manage it.');
    }

    const orgStamp = stampNew(ctx);
    const organization: OrganizationRow = {
      ...orgStamp,
      id: orgId,
      name: orgName,
      landlord_name: trimOrNull(input.landlordName),
      kra_pin: trimOrNull(input.kraPin),
      phone,
      default_unit_term: unitTerm,
      currency: 'KES',
      timezone: 'Africa/Nairobi',
      cloud_org_id: null,
    };
    insertRow(db, 'organizations', organization);
    recordOp(ctx, 'organizations', organization);

    const deviceStamp = stampNew(ctx);
    const device: DeviceRow = {
      ...deviceStamp,
      id: deviceId,
      name: deviceName,
      platform: input.platform,
      status: 'ACTIVE',
      key_fingerprint: null,
      is_self: 1,
      paired_at: clock.nowIso(),
      last_seen_at: clock.nowIso(),
      last_sync_hlc: null,
    };
    insertRow(db, 'devices', device);
    recordOp(ctx, 'devices', device);

    const userStamp = stampNew(ctx);
    const owner: UserRow = {
      ...userStamp,
      id: ownerId,
      full_name: (input.landlordName?.trim() || orgName),
      phone,
      email: null,
      role: 'OWNER',
      is_active: 1,
    };
    insertRow(db, 'users', owner);
    recordOp(ctx, 'users', owner);

    appendAudit(ctx, {
      action: 'ORGANIZATION_CREATED',
      entityType: 'organization',
      entityId: orgId,
      summary: `Kitabu set up for ${orgName}. Everything is saved on this device.`,
    });
    appendAudit(ctx, {
      action: 'DEVICE_REGISTERED',
      entityType: 'device',
      entityId: deviceId,
      summary: `Device "${deviceName}" (${input.platform}) registered as this phone's Kitabu device.`,
    });
    appendAudit(ctx, {
      action: 'USER_ADDED',
      entityType: 'user',
      entityId: ownerId,
      summary: `${owner.full_name} added as Owner.`,
    });

    setSetting(db, 'active_org_id', orgId);
    setSetting(db, 'active_user_id', ownerId);

    return { ctx, organization, device, owner };
  });
}

export class OrganizationService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  get(): OrganizationRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM organizations WHERE org_id = ? AND deleted_at IS NULL')
      .get(this.ctx.orgId) as OrganizationRow | undefined;
    if (row === undefined) throw domainRule('Organization not found.');
    return row;
  }

  update(input: {
    name?: string;
    landlordName?: string | null;
    kraPin?: string | null;
    phone?: string | null;
    unitTerm?: string;
  }): OrganizationRow {
    return this.ctx.db.transaction(() => {
      const org = this.get();
      const before = { ...org };

      if (input.name !== undefined) {
        const name = input.name.trim();
        if (name === '') throw validationError('The organization name cannot be empty.');
        org.name = name;
      }
      if (input.landlordName !== undefined) org.landlord_name = trimOrNull(input.landlordName ?? undefined);
      if (input.kraPin !== undefined) org.kra_pin = trimOrNull(input.kraPin ?? undefined);
      if (input.phone !== undefined) {
        if (input.phone === null || input.phone.trim() === '') {
          org.phone = null;
        } else {
          const normalized = normalizeKenyanMobile(input.phone);
          if (normalized === null) throw validationError('That phone number does not look right.');
          org.phone = normalized;
        }
      }
      if (input.unitTerm !== undefined) {
        const term = input.unitTerm.trim();
        if (!UNIT_TERM_OPTIONS.includes(term)) throw validationError('Choose House, Unit, Room or Apartment.');
        org.default_unit_term = term;
      }

      stampUpdate(this.ctx, org);
      updateRow(this.ctx.db, 'organizations', org);
      recordOp(this.ctx, 'organizations', org);
      appendAudit(this.ctx, {
        action: 'ORGANIZATION_UPDATED',
        entityType: 'organization',
        entityId: org.id,
        summary: 'Organization details updated.',
        before,
        after: { ...org },
      });
      return org;
    });
  }
}
