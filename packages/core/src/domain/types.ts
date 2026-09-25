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

// ---------------------------------------------------------------------------
// Financial core (schema v2, docs/DATABASE.md §4)
// ---------------------------------------------------------------------------

export type PaymentMethod = 'CASH' | 'MPESA' | 'BANK' | 'OTHER';
export type PaymentStatus = 'PENDING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'REVERSED';
export type LedgerEntryType = 'CHARGE' | 'PAYMENT_CREDIT' | 'ADJUSTMENT' | 'REVERSAL';
export type LedgerDirection = 'DEBIT' | 'CREDIT';
export type LedgerKind = 'RENT' | 'WATER' | 'GARBAGE' | 'LATE_FEE' | 'PENALTY' | 'DISCOUNT' | 'OTHER';
export type LedgerSource = 'AUTO_GENERATED' | 'MANUAL' | 'SYNC' | 'MIGRATION';

export const PAYMENT_METHODS: readonly PaymentMethod[] = ['CASH', 'MPESA', 'BANK', 'OTHER'];
export const LEDGER_KINDS: readonly LedgerKind[] = ['RENT', 'WATER', 'GARBAGE', 'LATE_FEE', 'PENALTY', 'DISCOUNT', 'OTHER'];

export interface PaymentRow extends SyncColumns {
  tenancy_id: string;
  property_id: string;
  unit_id: string;
  tenant_id: string;
  amount_minor: number;
  method: PaymentMethod;
  paid_at: string;
  reference: string | null;
  payer_name: string | null;
  status: PaymentStatus;
  verified_at: string | null;
  verified_by_user_id: string | null;
  verification_note: string | null;
  reversal_reason: string | null;
  recorded_by_user_id: string | null;
  recorded_by_device_id: string;
}

export interface LedgerEntryRow extends SyncColumns {
  tenancy_id: string;
  property_id: string;
  unit_id: string;
  tenant_id: string;
  entry_date: string;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  amount_minor: number;
  kind: LedgerKind;
  period: string | null;
  payment_id: string | null;
  reversal_of: string | null;
  reason: string | null;
  note: string | null;
  source: LedgerSource;
  posted_by_user_id: string | null;
  posted_by_device_id: string;
}

export interface PaymentAllocationRow extends SyncColumns {
  payment_id: string;
  charge_id: string;
  amount_minor: number;
}

export interface ReceiptRow extends SyncColumns {
  receipt_no: string;
  payment_id: string;
  tenancy_id: string;
  property_id: string;
  snapshot_json: string;
  digest: string;
  signature_image_id: string | null;
  signature_digest: string | null;
  crypto_signature: string | null;
  issued_by_user_id: string | null;
  issued_by_device_id: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface SignatureImageRow extends SyncColumns {
  property_id: string | null;
  label: string;
  image_ref: string;
  image_digest: string;
  active_from: string;
  active_to: string | null;
  created_by_user_id: string | null;
}

export interface ReceiptNumberBlockRow extends SyncColumns {
  device_id: string;
  block_start: number;
  block_end: number;
  next_value: number;
}

export interface OrgKeyRow extends SyncColumns {
  purpose: string;
  public_key: string;
  private_key: string;
}
