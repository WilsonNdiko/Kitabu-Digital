/**
 * @kitabu/core — public API (platform-neutral).
 *
 * NOTE: this entry exports NO platform adapter. App shells and tests inject their
 * SqlitePort (Node: `@kitabu/core/node`; Electron: better-sqlite3 adapter;
 * React Native: quick-sqlite/op-sqlite adapter).
 */

// foundation
export { KitabuError, friendlyStorageError, validationError, notFound, domainRule, permissionError } from './foundation/errors.ts';
export type { KitabuErrorCode } from './foundation/errors.ts';
export { uuidv7, isUuidv7, uuidv7Timestamp, UlidFactory, isUlid, defaultRandom } from './foundation/ids.ts';
export type { RandomPort } from './foundation/ids.ts';
export { SystemClock, ManualClock, isValidIsoDate } from './foundation/clock.ts';
export type { Clock } from './foundation/clock.ts';
export { Hlc, HybridLogicalClock } from './foundation/hlc.ts';
export { Money, formatKsh } from './foundation/money.ts';
export { normalizeKenyanMobile, isValidKenyanMobile, formatKenyanMobile } from './foundation/phone.ts';
export { sha256, sha256Hex, sha256HexOfUtf8, utf8Bytes } from './foundation/sha256.ts';
export { canonicalJson } from './foundation/canonicaljson.ts';
export { bytesToBase64, base64ToBytes } from './foundation/base64.ts';
export { shillingsInWords } from './foundation/numwords.ts';
export type { CryptoPort, Ed25519KeyPair } from './foundation/crypto.ts';

// db (ports + schema, no adapter)
export type { SqlitePort, SqliteStatement, SqliteValue } from './db/port.ts';
export { getRow, allRows } from './db/port.ts';
export { migrate, MIGRATIONS, SCHEMA_VERSION } from './db/schema.ts';
export { SYNCED_TABLES } from './db/crud.ts';
export type { TableName } from './db/crud.ts';

// domain
export type {
  DevicePlatform, DeviceStatus, UserRole, UnitKind, UnitStatus, TenancyStatus, SyncOpKind,
  SyncColumns, OrganizationRow, DeviceRow, UserRow, PropertyRow, BuildingRow, UnitRow,
  TenantRow, TenancyRow, RentRateRow, AuditLogRow, ChangeLogRow,
  PaymentMethod, PaymentStatus, LedgerEntryType, LedgerDirection, LedgerKind, LedgerSource,
  PaymentRow, LedgerEntryRow, PaymentAllocationRow, ReceiptRow, SignatureImageRow,
  ReceiptNumberBlockRow, OrgKeyRow,
} from './domain/types.ts';
export { UNIT_KINDS, PAYMENT_METHODS, LEDGER_KINDS } from './domain/types.ts';

// services
export type { ServiceContext } from './services/context.ts';
export { currentUserRole, requireRole } from './services/context.ts';
export type { BootstrapInput, BootstrapResult } from './services/organization.ts';
export { bootstrapOrganization, OrganizationService } from './services/organization.ts';
export type { PropertyWithCounts, PropertySummary } from './services/property.ts';
export { PropertyService } from './services/property.ts';
export type { RegisterTenantInput } from './services/tenant.ts';
export { TenantService } from './services/tenant.ts';
export type { StartTenancyInput, TenancyHistoryEntry } from './services/tenancy.ts';
export { TenancyService } from './services/tenancy.ts';
export { AuditService } from './services/audit.ts';
export type { ChargeGenerationResult, MonthStatus, ArrearsRow, StatementLine, TenancyStatement } from './services/ledger.ts';
export { LedgerService } from './services/ledger.ts';
export type { RecordPaymentInput } from './services/payment.ts';
export { PaymentService } from './services/payment.ts';
export type { IssueReceiptResult, ReceiptSnapshot, ReceiptIntegrity } from './services/receipt.ts';
export { ReceiptService, RECEIPT_BLOCK_SIZE, voidReceiptTx } from './services/receipt.ts';
export { newChangeId, stampNew, stampUpdate, recordOp, appendAudit } from './services/mutations.ts';
export type { AuditEntry } from './services/mutations.ts';

// facade
export { Kitabu } from './kitabu.ts';
export type { KitabuOptions, KitabuServices } from './kitabu.ts';
