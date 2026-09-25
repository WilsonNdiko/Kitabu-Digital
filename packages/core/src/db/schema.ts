/**
 * Local database schema — version 1 (Milestone 1).
 *
 * Canonical DDL (documented in docs/DATABASE.md §3). Every migration is pure SQL and
 * applied by `migrate()`. Financial tables (v2) and operations tables (v3) are
 * documented in DATABASE.md and land in their milestones.
 *
 * Invariants:
 * - every synced table carries the sync columns (id/org_id/created_at/updated_at/
 *   deleted_at/version/hlc/origin_device_id)
 * - one ACTIVE tenancy per unit (partial unique index) — holds even under sync races
 * - change_log is local-only and append-only; it is the device's complete op stream
 */

import type { SqlitePort } from './port.ts';
import { getRow } from './port.ts';
import { KitabuError } from '../foundation/errors.ts';

export const SCHEMA_VERSION = 1;

const SCHEMA_V1: readonly string[] = [
  // -- organizations ---------------------------------------------------------
  `CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    landlord_name TEXT,
    kra_pin TEXT,
    phone TEXT,
    default_unit_term TEXT NOT NULL DEFAULT 'House',
    currency TEXT NOT NULL DEFAULT 'KES',
    timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    cloud_org_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,

  // -- devices ---------------------------------------------------------------
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ANDROID','WINDOWS')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
    key_fingerprint TEXT,
    is_self INTEGER NOT NULL DEFAULT 0,
    paired_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_sync_hlc TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_devices_org ON devices(org_id)`,

  // -- users -----------------------------------------------------------------
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CARETAKER')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_users_org ON users(org_id)`,

  // -- properties ------------------------------------------------------------
  `CREATE TABLE properties (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    town TEXT,
    estate TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_properties_org ON properties(org_id)`,

  // -- buildings -------------------------------------------------------------
  `CREATE TABLE buildings (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    property_id TEXT NOT NULL REFERENCES properties(id),
    name TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_buildings_property ON buildings(property_id)`,

  // -- units -----------------------------------------------------------------
  `CREATE TABLE units (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    property_id TEXT NOT NULL REFERENCES properties(id),
    building_id TEXT REFERENCES buildings(id),
    label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'HOUSE' CHECK (kind IN ('HOUSE','APARTMENT','ROOM','BEDSITTER','SHOP','OTHER')),
    status TEXT NOT NULL DEFAULT 'VACANT' CHECK (status IN ('VACANT','OCCUPIED','RESERVED','MAINTENANCE')),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_units_property ON units(org_id, property_id)`,
  `CREATE INDEX idx_units_status ON units(org_id, status)`,
  `CREATE UNIQUE INDEX idx_units_label ON units(property_id, label) WHERE deleted_at IS NULL`,

  // -- tenants ---------------------------------------------------------------
  `CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
    phone TEXT,
    alt_phone TEXT,
    id_number TEXT,
    email TEXT,
    emergency_contact TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_tenants_org_name ON tenants(org_id, full_name)`,
  `CREATE INDEX idx_tenants_org_phone ON tenants(org_id, phone)`,

  // -- tenancies -------------------------------------------------------------
  `CREATE TABLE tenancies (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    unit_id TEXT NOT NULL REFERENCES units(id),
    property_id TEXT NOT NULL REFERENCES properties(id),
    start_date TEXT NOT NULL,
    end_date TEXT,
    end_reason TEXT,
    expected_payment_day INTEGER NOT NULL DEFAULT 5 CHECK (expected_payment_day BETWEEN 1 AND 28),
    deposit_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (deposit_amount_minor >= 0),
    deposit_paid INTEGER NOT NULL DEFAULT 0,
    current_rent_minor INTEGER NOT NULL CHECK (current_rent_minor > 0),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','ENDED')),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    CHECK (end_date IS NULL OR end_date >= start_date)
  )`,
  `CREATE INDEX idx_tenancies_unit ON tenancies(org_id, unit_id, status)`,
  `CREATE INDEX idx_tenancies_tenant ON tenancies(org_id, tenant_id, status)`,
  `CREATE UNIQUE INDEX idx_tenancies_one_active_per_unit
     ON tenancies(unit_id) WHERE status = 'ACTIVE' AND deleted_at IS NULL`,

  // -- rent rates ------------------------------------------------------------
  `CREATE TABLE rent_rates (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    tenancy_id TEXT NOT NULL REFERENCES tenancies(id),
    effective_from TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    reason TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX idx_rent_rates_tenancy_effective
     ON rent_rates(tenancy_id, effective_from) WHERE deleted_at IS NULL`,

  // -- audit log (append-only, synced) ---------------------------------------
  `CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor_user_id TEXT,
    actor_device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_audit_org_time ON audit_log(org_id, occurred_at)`,
  `CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id)`,

  // -- change log (LOCAL ONLY: complete op stream of this device) --------------
  `CREATE TABLE change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('UPSERT','DELETE')),
    payload_json TEXT NOT NULL,
    row_version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_changelog_hlc ON change_log(hlc, change_id)`,
  `CREATE INDEX idx_changelog_row ON change_log(table_name, row_id)`,

  // -- app settings (LOCAL ONLY) ----------------------------------------------
  `CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

export function migrate(db: SqlitePort): void {
  const row = getRow<{ user_version: number }>(db, 'PRAGMA user_version');
  const current = row?.user_version ?? 0;

  if (current > SCHEMA_VERSION) {
    throw new KitabuError(
      'SCHEMA',
      'This data was created by a newer version of Kitabu. Please update the app.',
      `user_version ${current} > supported ${SCHEMA_VERSION}`,
    );
  }
  if (current === SCHEMA_VERSION) return;

  db.transaction(() => {
    for (const stmt of SCHEMA_V1) db.exec(stmt);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}
