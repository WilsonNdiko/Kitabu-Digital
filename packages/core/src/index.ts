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

// db (ports + schema, no adapter)
export type { SqlitePort, SqliteStatement, SqliteValue } from './db/port.ts';
export { getRow, allRows } from './db/port.ts';
export { migrate, SCHEMA_VERSION } from './db/schema.ts';
export { SYNCED_TABLES } from './db/crud.ts';
export type { TableName } from './db/crud.ts';

// domain
export type {
  DevicePlatform, DeviceStatus, UserRole, UnitKind, UnitStatus, TenancyStatus, SyncOpKind,
  SyncColumns, OrganizationRow, DeviceRow, UserRow, PropertyRow, BuildingRow, UnitRow,
  TenantRow, TenancyRow, RentRateRow, AuditLogRow, ChangeLogRow,
} from './domain/types.ts';
export { UNIT_KINDS } from './domain/types.ts';

// services
export type { ServiceContext } from './services/context.ts';
export { currentUserRole } from './services/context.ts';
export type { BootstrapInput, BootstrapResult } from './services/organization.ts';
export { bootstrapOrganization, OrganizationService } from './services/organization.ts';
export type { PropertyWithCounts, PropertySummary } from './services/property.ts';
export { PropertyService } from './services/property.ts';
export type { RegisterTenantInput } from './services/tenant.ts';
export { TenantService } from './services/tenant.ts';
export type { StartTenancyInput, TenancyHistoryEntry } from './services/tenancy.ts';
export { TenancyService } from './services/tenancy.ts';
export { AuditService } from './services/audit.ts';
export { newChangeId, stampNew, stampUpdate, recordOp, appendAudit } from './services/mutations.ts';
export type { AuditEntry } from './services/mutations.ts';

// facade
export { Kitabu } from './kitabu.ts';
export type { KitabuOptions, KitabuServices } from './kitabu.ts';
