-- Kitabu Digital — local SQLite schema (authoritative DDL; see docs/DATABASE.md)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  terminology TEXT NOT NULL DEFAULT 'House',
  currency TEXT NOT NULL DEFAULT 'KES',
  settings_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  full_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CARETAKER')),
  pin_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_properties_org ON properties(org_id);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  building_id TEXT,
  label TEXT NOT NULL,
  monthly_rent_minor INTEGER NOT NULL CHECK (monthly_rent_minor >= 0),
  deposit_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'VACANT' CHECK (status IN ('VACANT','OCCUPIED','MAINTENANCE')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_units_label ON units(property_id, label) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  alt_phone TEXT,
  id_number TEXT,
  email TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_org ON tenants(org_id);
CREATE INDEX IF NOT EXISTS idx_tenants_phone ON tenants(phone);

CREATE TABLE IF NOT EXISTS tenancies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  unit_id TEXT NOT NULL REFERENCES units(id),
  property_id TEXT NOT NULL,
  rent_minor INTEGER NOT NULL CHECK (rent_minor >= 0),
  deposit_minor INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT,
  expected_pay_day INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenancies_tenant ON tenancies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenancies_unit ON tenancies(unit_id);
-- one ACTIVE tenancy per unit (rule §48.6 / docs/SYNC.md conflict policy)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenancy_active_unit ON tenancies(unit_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS rent_rates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tenancy_id TEXT NOT NULL REFERENCES tenancies(id),
  rent_minor INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rent_rates_tenancy ON rent_rates(tenancy_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tenancy_id TEXT NOT NULL REFERENCES tenancies(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('CHARGE','PAYMENT','ADJUSTMENT','CREDIT','REVERSAL')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
  period TEXT,
  effective_date TEXT NOT NULL,
  payment_id TEXT,
  reverses_entry_id TEXT,
  memo TEXT,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_tenancy ON ledger_entries(tenancy_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_charge_period
  ON ledger_entries(tenancy_id, period) WHERE entry_type = 'CHARGE';

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tenancy_id TEXT NOT NULL REFERENCES tenancies(id),
  tenant_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL CHECK (method IN ('MPESA','CASH','BANK','OTHER')),
  reference TEXT,
  payer_name TEXT,
  payment_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','VERIFYING','VERIFIED','REJECTED','REVERSED')),
  recorded_by TEXT NOT NULL,
  verified_by TEXT,
  verified_at TEXT,
  rejected_reason TEXT,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_tenancy ON payments(tenancy_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
-- duplicate transaction references rejected at the engine level (docs/MPESA.md §3)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_reference
  ON payments(org_id, method, reference) WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  receipt_no TEXT NOT NULL UNIQUE,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  issued_at TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,          -- immutable snapshot at issuance
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  category TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL DEFAULT 'CASH',
  reference TEXT,
  expense_date TEXT NOT NULL,
  description TEXT,
  recorded_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  unit_id TEXT,
  tenant_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH')),
  status TEXT NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','ASSIGNED','IN_PROGRESS','COMPLETED')),
  assigned_to TEXT,
  cost_minor INTEGER,
  reported_at TEXT NOT NULL,
  completed_at TEXT,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_property ON maintenance_requests(property_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_code TEXT NOT NULL,
  public_key TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  paired_at TEXT NOT NULL,
  last_sync_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  origin_device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org_at ON audit_log(org_id, at);

-- Change log: appended in the SAME transaction as every write (docs/SYNC.md §2)
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('UPSERT','DELETE')),
  payload_json TEXT NOT NULL,
  hlc TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  synced_to_cloud INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_log_pending ON change_log(synced_to_cloud);

-- Changes applied from elsewhere: dedup across sync paths (docs/SYNC.md §2)
CREATE TABLE IF NOT EXISTS applied_changes (
  change_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_peers (
  device_id TEXT PRIMARY KEY,
  last_seq_received INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT
);
