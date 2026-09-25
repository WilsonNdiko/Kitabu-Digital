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

export const SCHEMA_VERSION = 2;

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

// ---------------------------------------------------------------------------
// Schema v2 — financial core (Milestone 2). Tables + DB-level immutability
// triggers (docs/DATABASE.md §4, FINANCIAL-LEDGER.md §7):
//   - ledger_entries: no UPDATE, no DELETE — append-only journal
//   - payments: legal state transitions only; amount/ref/date/method frozen
//     once VERIFIED or REVERSED
//   - payment_allocations: insert-only; sum per payment can never exceed the
//     payment amount (trigger)
//   - receipts: core fields frozen; only void columns + sync metadata change
// ---------------------------------------------------------------------------

const SCHEMA_V2: readonly string[] = [
  `CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    tenancy_id TEXT NOT NULL REFERENCES tenancies(id),
    property_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    method TEXT NOT NULL CHECK (method IN ('CASH','MPESA','BANK','OTHER')),
    paid_at TEXT NOT NULL,
    reference TEXT,
    payer_name TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFYING','VERIFIED','REJECTED','REVERSED')),
    verified_at TEXT,
    verified_by_user_id TEXT,
    verification_note TEXT,
    reversal_reason TEXT,
    recorded_by_user_id TEXT,
    recorded_by_device_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_payments_status ON payments(org_id, status)`,
  `CREATE INDEX idx_payments_tenancy ON payments(org_id, tenancy_id, paid_at)`,
  `CREATE INDEX idx_payments_property_month ON payments(org_id, property_id, paid_at)`,
  `CREATE UNIQUE INDEX idx_payments_ref ON payments(org_id, method, reference)
     WHERE reference IS NOT NULL`,

  `CREATE TABLE signature_images (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    property_id TEXT REFERENCES properties(id),
    label TEXT NOT NULL DEFAULT 'Signature',
    image_ref TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    active_from TEXT NOT NULL,
    active_to TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_signature_active ON signature_images(org_id, property_id, active_to)`,

  `CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    tenancy_id TEXT NOT NULL REFERENCES tenancies(id),
    property_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('CHARGE','PAYMENT_CREDIT','ADJUSTMENT','REVERSAL')),
    direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    kind TEXT NOT NULL DEFAULT 'OTHER' CHECK (kind IN ('RENT','WATER','GARBAGE','LATE_FEE','PENALTY','DISCOUNT','OTHER')),
    period TEXT,
    payment_id TEXT REFERENCES payments(id),
    reversal_of TEXT REFERENCES ledger_entries(id),
    reason TEXT,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('AUTO_GENERATED','MANUAL','SYNC','MIGRATION')),
    posted_by_user_id TEXT,
    posted_by_device_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_ledger_tenancy ON ledger_entries(org_id, tenancy_id, entry_date)`,
  `CREATE INDEX idx_ledger_period ON ledger_entries(org_id, period, kind)`,
  `CREATE INDEX idx_ledger_payment ON ledger_entries(payment_id)`,
  `CREATE UNIQUE INDEX idx_ledger_rent_period ON ledger_entries(tenancy_id, period, kind)
     WHERE entry_type = 'CHARGE' AND source = 'AUTO_GENERATED' AND deleted_at IS NULL`,

  `CREATE TABLE payment_allocations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    payment_id TEXT NOT NULL REFERENCES payments(id),
    charge_id TEXT NOT NULL REFERENCES ledger_entries(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_allocations_payment ON payment_allocations(payment_id)`,
  `CREATE INDEX idx_allocations_charge ON payment_allocations(charge_id)`,
  `CREATE UNIQUE INDEX idx_allocations_pair ON payment_allocations(payment_id, charge_id)`,

  `CREATE TABLE receipt_number_blocks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    block_start INTEGER NOT NULL,
    block_end INTEGER NOT NULL,
    next_value INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    CHECK (block_start >= 1 AND block_end >= block_start AND next_value BETWEEN block_start AND block_end + 1)
  )`,
  `CREATE INDEX idx_blocks_device ON receipt_number_blocks(org_id, device_id)`,

  `CREATE TABLE org_keys (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX idx_org_keys_purpose ON org_keys(org_id, purpose)`,

  `CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    receipt_no TEXT NOT NULL,
    payment_id TEXT NOT NULL REFERENCES payments(id),
    tenancy_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    signature_image_id TEXT REFERENCES signature_images(id),
    signature_digest TEXT,
    crypto_signature TEXT,
    issued_by_user_id TEXT,
    issued_by_device_id TEXT NOT NULL,
    voided_at TEXT,
    void_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    origin_device_id TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX idx_receipts_no ON receipts(org_id, receipt_no)`,
  `CREATE INDEX idx_receipts_payment ON receipts(payment_id)`,

  // -- immutability triggers ---------------------------------------------------
  `CREATE TRIGGER trg_ledger_entries_no_update BEFORE UPDATE ON ledger_entries
   BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END`,
  `CREATE TRIGGER trg_ledger_entries_no_delete BEFORE DELETE ON ledger_entries
   BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END`,

  `CREATE TRIGGER trg_payments_status_transition BEFORE UPDATE ON payments
   WHEN NEW.status != OLD.status AND NOT (
     (OLD.status = 'PENDING'   AND NEW.status IN ('VERIFYING','VERIFIED','REJECTED')) OR
     (OLD.status = 'VERIFYING' AND NEW.status IN ('PENDING','VERIFIED','REJECTED')) OR
     (OLD.status = 'VERIFIED'  AND NEW.status = 'REVERSED')
   )
   BEGIN SELECT RAISE(ABORT, 'PAYMENT_ILLEGAL_TRANSITION'); END`,
  `CREATE TRIGGER trg_payments_immutable BEFORE UPDATE ON payments
   WHEN OLD.status IN ('VERIFIED','REVERSED') AND (
     NEW.amount_minor != OLD.amount_minor OR NEW.method != OLD.method OR
     NEW.paid_at != OLD.paid_at OR NEW.reference IS NOT OLD.reference OR
     NEW.tenancy_id != OLD.tenancy_id OR NEW.tenant_id != OLD.tenant_id
   )
   BEGIN SELECT RAISE(ABORT, 'PAYMENT_IMMUTABLE'); END`,

  `CREATE TRIGGER trg_payment_allocations_no_update BEFORE UPDATE ON payment_allocations
   BEGIN SELECT RAISE(ABORT, 'ALLOCATION_IMMUTABLE'); END`,
  `CREATE TRIGGER trg_payment_allocations_no_delete BEFORE DELETE ON payment_allocations
   BEGIN SELECT RAISE(ABORT, 'ALLOCATION_IMMUTABLE'); END`,
  `CREATE TRIGGER trg_allocations_within_payment BEFORE INSERT ON payment_allocations
   BEGIN
     SELECT RAISE(ABORT, 'ALLOCATION_EXCEEDS_PAYMENT') WHERE
       (SELECT COALESCE(SUM(a.amount_minor), 0) FROM payment_allocations a
          WHERE a.payment_id = NEW.payment_id AND a.id != NEW.id) + NEW.amount_minor
       > (SELECT p.amount_minor FROM payments p WHERE p.id = NEW.payment_id);
   END`,

  `CREATE TRIGGER trg_receipts_immutable BEFORE UPDATE ON receipts
   WHEN NEW.receipt_no != OLD.receipt_no OR NEW.payment_id != OLD.payment_id OR
        NEW.snapshot_json != OLD.snapshot_json OR NEW.digest != OLD.digest OR
        NEW.crypto_signature IS NOT OLD.crypto_signature OR
        NEW.signature_image_id IS NOT OLD.signature_image_id OR
        NEW.signature_digest IS NOT OLD.signature_digest
   BEGIN SELECT RAISE(ABORT, 'RECEIPT_IMMUTABLE'); END`,
  `CREATE TRIGGER trg_receipts_no_delete BEFORE DELETE ON receipts
   BEGIN SELECT RAISE(ABORT, 'RECEIPT_IMMUTABLE'); END`,
];

export const MIGRATIONS: ReadonlyArray<{ toVersion: number; statements: readonly string[] }> = [
  { toVersion: 1, statements: SCHEMA_V1 },
  { toVersion: 2, statements: SCHEMA_V2 },
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

  for (const migration of MIGRATIONS) {
    if (migration.toVersion <= current) continue;
    db.transaction(() => {
      for (const stmt of migration.statements) db.exec(stmt);
      db.exec(`PRAGMA user_version = ${migration.toVersion}`);
    });
  }
}
