/**
 * Domain row types — mirror the database schema v1 (docs/DATABASE.md §3).
 * Rows are the domain shape for Milestone 1 (also what op-log payloads contain);
 * app shells map them to view models.
 */

export type DevicePlatform = 'ANDROID' | 'WINDOWS';
export type DeviceStatus = 'ACTIVE' | 'REVOKED';
export type UserRole = 'OWNER' | 'MANAGER' | 'CARETAKER';
export type UnitKind = 'HOUSE' | 'APARTMENT' | 'ROOM' | 'BEDSITTER' | 'SHOP' | 'OTHER';
export type UnitStatus = 'VACANT' | 'OCCUPIED' | 'RESERVED' | 'MAINTENANCE';
export type TenancyStatus = 'ACTIVE' | 'ENDED';
export type SyncOpKind = 'UPSERT' | 'DELETE';

export const UNIT_KINDS: readonly UnitKind[] = ['HOUSE', 'APARTMENT', 'ROOM', 'BEDSITTER', 'SHOP', 'OTHER'];

/** Standard change-tracking columns on every synced table (docs/DATABASE.md §1). */
export interface SyncColumns {
  id: string;
  org_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  hlc: string;
  origin_device_id: string;
}

export interface OrganizationRow extends SyncColumns {
  name: string;
  landlord_name: string | null;
  kra_pin: string | null;
  phone: string | null;
  default_unit_term: string;
  currency: string;
  timezone: string;
  cloud_org_id: string | null;
}

export interface DeviceRow extends SyncColumns {
  name: string;
  platform: DevicePlatform;
  status: DeviceStatus;
  key_fingerprint: string | null;
  is_self: 0 | 1;
  paired_at: string;
  last_seen_at: string | null;
  last_sync_hlc: string | null;
}

export interface UserRow extends SyncColumns {
  full_name: string;
  phone: string | null;
  email: string | null;
  role: UserRole;
  is_active: 0 | 1;
}

export interface PropertyRow extends SyncColumns {
  name: string;
  town: string | null;
  estate: string | null;
  notes: string | null;
}

export interface BuildingRow extends SyncColumns {
  property_id: string;
  name: string;
  notes: string | null;
}

export interface UnitRow extends SyncColumns {
  property_id: string;
  building_id: string | null;
  label: string;
  kind: UnitKind;
  status: UnitStatus;
  notes: string | null;
}

export interface TenantRow extends SyncColumns {
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  id_number: string | null;
  email: string | null;
  emergency_contact: string | null;
  notes: string | null;
}

export interface TenancyRow extends SyncColumns {
  tenant_id: string;
  unit_id: string;
  property_id: string;
  start_date: string;
  end_date: string | null;
  end_reason: string | null;
  expected_payment_day: number;
  deposit_amount_minor: number;
  deposit_paid: 0 | 1;
  current_rent_minor: number;
  status: TenancyStatus;
  notes: string | null;
}

export interface RentRateRow extends SyncColumns {
  tenancy_id: string;
  effective_from: string;
  amount_minor: number;
  reason: string | null;
  created_by_user_id: string | null;
}

export interface AuditLogRow extends SyncColumns {
  occurred_at: string;
  actor_user_id: string | null;
  actor_device_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  before_json: string | null;
  after_json: string | null;
}

/** LOCAL ONLY — the device's complete operation stream (docs/SYNC.md §1). */
export interface ChangeLogRow {
  seq: number;
  change_id: string;
  org_id: string;
  table_name: string;
  row_id: string;
  op: SyncOpKind;
  payload_json: string;
  row_version: number;
  hlc: string;
  origin_device_id: string;
  created_at: string;
}
