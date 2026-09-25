/**
 * Kitabu — the application facade (Level 1: single device).
 *
 * Opens the local database (the operational database, never a cache), migrates it,
 * and either loads the existing organization or waits for `bootstrap()`. All services
 * share one ServiceContext (clock, HLC, device identity, org, acting user).
 */

import type { SqlitePort } from './db/port.ts';
import { getRow } from './db/port.ts';
import { migrate } from './db/schema.ts';
import { setting, setSetting } from './db/crud.ts';
import type { Clock } from './foundation/clock.ts';
import { SystemClock } from './foundation/clock.ts';
import type { CryptoPort } from './foundation/crypto.ts';
import { HybridLogicalClock } from './foundation/hlc.ts';
import { KitabuError } from './foundation/errors.ts';
import type { DeviceRow, OrganizationRow } from './domain/types.ts';
import type { ServiceContext } from './services/context.ts';
import { requireRole } from './services/context.ts';
import { bootstrapOrganization } from './services/organization.ts';
import type { BootstrapInput, BootstrapResult } from './services/organization.ts';
import { OrganizationService } from './services/organization.ts';
import { PropertyService } from './services/property.ts';
import { TenantService } from './services/tenant.ts';
import { TenancyService } from './services/tenancy.ts';
import { AuditService } from './services/audit.ts';
import { LedgerService } from './services/ledger.ts';
import { PaymentService } from './services/payment.ts';
import { ReceiptService } from './services/receipt.ts';
import { createBackup, applySnapshot } from './services/backup.ts';
import type { BackupKdfParams, SnapshotPayload } from './services/backup.ts';

export interface KitabuOptions {
  /** An open, pragma-configured SQLite connection (`:memory:` or file). */
  sqlite: SqlitePort;
  /** Injectable clock (tests pass ManualClock; apps use SystemClock). */
  clock?: Clock;
  /** Injectable Ed25519 signing (receipt tamper-evidence). Node impl in ./node.ts. */
  crypto?: CryptoPort;
}
export interface KitabuServices {
  organization: OrganizationService;
  property: PropertyService;
  tenant: TenantService;
  tenancy: TenancyService;
  audit: AuditService;
  ledger: LedgerService;
  payment: PaymentService;
  receipt: ReceiptService;
}

export class Kitabu {
  readonly #db: SqlitePort;
  readonly #clock: Clock;
  readonly #crypto: CryptoPort | undefined;
  #ctx: ServiceContext | null = null;
  #services: KitabuServices | null = null;

  private constructor(db: SqlitePort, clock: Clock, crypto?: CryptoPort) {
    this.#db = db;
    this.#clock = clock;
    this.#crypto = crypto;
  }

  /** Open + migrate the local database; loads organization state if present. */
  static open(options: KitabuOptions): Kitabu {
    const clock = options.clock ?? new SystemClock();
    migrate(options.sqlite);
    const kitabu = new Kitabu(options.sqlite, clock, options.crypto);
    kitabu.#loadExisting();
    return kitabu;
  }

  #loadExisting(): void {
    const org = getRow<OrganizationRow>(this.#db, 'SELECT * FROM organizations WHERE deleted_at IS NULL LIMIT 1');
    if (org === undefined) return;
    const device = getRow<DeviceRow>(this.#db, 'SELECT * FROM devices WHERE org_id = ? AND is_self = 1 AND deleted_at IS NULL', [org.id]);
    if (device === undefined) {
      throw new KitabuError('SCHEMA', 'This Kitabu data is missing its device record. Please restore a backup.', 'self device row missing');
    }
    const hlcClock = new HybridLogicalClock(device.id, this.#clock);
    const lastHlc = setting(this.#db, 'last_hlc');
    if (lastHlc !== null) hlcClock.restore(lastHlc);

    const activeUser = setting(this.#db, 'active_user_id');
    this.#ctx = {
      db: this.#db,
      clock: this.#clock,
      hlcClock,
      deviceId: device.id,
      orgId: org.id,
      userId: activeUser,
    };
    this.#services = this.#buildServices(this.#ctx);
  }

  #buildServices(ctx: ServiceContext): KitabuServices {
    return {
      organization: new OrganizationService(ctx),
      property: new PropertyService(ctx),
      tenant: new TenantService(ctx),
      tenancy: new TenancyService(ctx),
      audit: new AuditService(ctx),
      ledger: new LedgerService(ctx),
      payment: new PaymentService(ctx),
      receipt: new ReceiptService(ctx, this.#crypto),
    };
  }

  /** First-run organization setup (idempotent guard: one org per local database). */
  bootstrap(input: BootstrapInput): BootstrapResult {
    if (this.#ctx !== null) {
      throw new KitabuError('DOMAIN_RULE', 'This device already has a Kitabu organization.');
    }
    const result = bootstrapOrganization(this.#db, this.#clock, input);
    this.#ctx = result.ctx;
    this.#services = this.#buildServices(result.ctx);
    return result;
  }

  /**
   * Restore a snapshot onto a fresh database and open it (device replacement,
   * SYNC.md §6). The database must not already hold an organization.
   */
  static openFromSnapshot(options: KitabuOptions & { snapshot: SnapshotPayload }): Kitabu {
    applySnapshot(options.sqlite, options.snapshot);
    return Kitabu.open(options);
  }

  /**
   * Export the whole live database as one passphrase-encrypted backup archive
   * (FR-22, SECURITY.md §4). Owner-only. Records the export time for the
   * Settings screen ("last backup").
   */
  exportBackup(passphrase: string, params?: Partial<BackupKdfParams>): Uint8Array {
    this.#requireBootstrapped();
    requireRole(this.#ctx!, ['OWNER'], 'export an encrypted backup');
    if (this.#crypto === undefined) {
      throw new KitabuError('VALIDATION', 'Backups are not available in this build of Kitabu (no crypto provider).');
    }
    const bytes = createBackup(this.#db, passphrase, {
      crypto: this.#crypto,
      params,
      nowIso: this.#clock.nowIso(),
    });
    setSetting(this.#db, 'backup.last_exported_at', this.#clock.nowIso());
    return bytes;
  }

  /** Read a local-only setting (app_settings; e.g. backup.last_exported_at). */
  localSetting(key: string): string | null {
    return setting(this.#db, key);
  }

  get isBootstrapped(): boolean {
    return this.#ctx !== null;
  }

  get orgId(): string {
    this.#requireBootstrapped();
    return this.#ctx!.orgId;
  }

  get deviceId(): string {
    this.#requireBootstrapped();
    return this.#ctx!.deviceId;
  }

  /** The acting user (set by app shells after unlock; null = device-level action). */
  get actingUserId(): string | null {
    this.#requireBootstrapped();
    return this.#ctx!.userId;
  }

  setActingUser(userId: string | null): void {
    this.#requireBootstrapped();
    this.#ctx!.userId = userId;
  }

  get services(): KitabuServices {
    this.#requireBootstrapped();
    return this.#services!;
  }

  /** Local device row (for the Devices screen, M5). */
  selfDevice(): DeviceRow {
    this.#requireBootstrapped();
    return getRow<DeviceRow>(
      this.#db,
      'SELECT * FROM devices WHERE org_id = ? AND is_self = 1 AND deleted_at IS NULL',
      [this.#ctx!.orgId],
    )!;
  }

  #requireBootstrapped(): void {
    if (this.#ctx === null) {
      throw new KitabuError('NOT_BOOTSTRAPPED', 'Set up your organization first.');
    }
  }

  close(): void {
    this.#db.close();
  }
}
