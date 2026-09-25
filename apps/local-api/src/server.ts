/**
 * Kitabu local API — the app-shell backend.
 *
 * In the shipped Windows app this layer lives inside the Electron main process
 * (IPC); the Android app binds the core directly. For the web shell (and for
 * developing/demoing the screens in a browser) it exposes the same core over
 * plain HTTP with **zero runtime dependencies** (node:http + @kitabu/core).
 *
 * Every financial rule, validation, trigger and audit entry comes from the core —
 * this file only routes JSON and maps KitabuError → HTTP status. The acting user
 * is chosen per request via the `X-Acting-User` header (the UI's user switcher),
 * so role enforcement (caretaker vs owner) is exercised exactly as on-device.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

import { openKitabuFile, openKitabuInMemory, openNodeSqlite, NodeCryptoPort } from '../../../packages/core/src/node.ts';
import { Kitabu } from '../../../packages/core/src/kitabu.ts';
import type { KitabuServices } from '../../../packages/core/src/kitabu.ts';
import { readBackup } from '../../../packages/core/src/services/backup.ts';
import { base64ToBytes } from '../../../packages/core/src/foundation/base64.ts';
import { KitabuError } from '../../../packages/core/src/foundation/errors.ts';
import type { ArrearsRow, MonthStatus } from '../../../packages/core/src/services/ledger.ts';
import type { PaymentRow, UnitKind } from '../../../packages/core/src/domain/types.ts';
import type { ReceiptRow } from '../../../packages/core/src/domain/types.ts';
import type { ReceiptSnapshot, ReceiptIntegrity } from '../../../packages/core/src/services/receipt.ts';

import { seedDemoData } from './seed.ts';

export interface ApiOptions {
  /** File-backed database (a real device's local DB). Omit for in-memory. */
  dbPath?: string;
  /** Seed demo data when the database is fresh (dev/demo only). */
  seedDemo?: boolean;
  /** Directory of the built web app to serve (optional, single-process demo). */
  staticDir?: string;
}

export interface ApiServer {
  server: Server;
  kitabu: Kitabu;
  port: () => number;
  close: () => Promise<void>;
}

// -- helpers ---------------------------------------------------------------------

interface Ctx {
  kitabu: Kitabu;
  options: ApiOptions;
}

function services(ctx: Ctx): KitabuServices {
  return ctx.kitabu.services;
}

/** Apply the UI's user switcher; default to the owner when unset. */
function applyActingUser(ctx: Ctx, req: IncomingMessage): void {
  if (!ctx.kitabu.isBootstrapped) return;
  const header = req.headers['x-acting-user'];
  const wanted = Array.isArray(header) ? header[0] : header;
  if (wanted !== undefined && wanted !== '') {
    ctx.kitabu.setActingUser(wanted);
    return;
  }
  if (ctx.kitabu.actingUserId === null) {
    const owner = services(ctx).organization.listUsers().find((u) => u.role === 'OWNER');
    if (owner !== undefined) ctx.kitabu.setActingUser(owner.id);
  }
}

const HTTP_BY_CODE: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  DOMAIN_RULE: 409,
  PERMISSION: 403,
  CONFLICT: 409,
  NOT_BOOTSTRAPPED: 409,
  SCHEMA: 500,
  NESTED_TRANSACTION: 500,
  STORAGE: 500,
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Generous cap: backup restore carries the whole database as base64 JSON.
    if (size > 50_000_000) throw new KitabuError('VALIDATION', 'That request is too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new KitabuError('VALIDATION', 'Send the request as a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof KitabuError) throw err;
    throw new KitabuError('VALIDATION', 'The request could not be read. Please try again.');
  }
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function int(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isSafeInteger(Number(v))) return Number(v);
  return undefined;
}

function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  return typeof v === 'boolean' ? v : undefined;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function previousMonths(count: number): string[] {
  const months: string[] = [];
  const base = new Date(`${currentMonth()}-01T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

// -- enrichments (joins the services don't do for us) ----------------------------

export interface EnrichedMonth extends MonthStatus {
  tenantId: string;
  tenantName: string;
  unitLabel: string;
  propertyName: string;
  rentMinor: number;
}

export interface EnrichedPayment extends PaymentRow {
  tenantName: string;
  unitLabel: string;
  propertyName: string;
  hasReceipt: boolean;
}

export interface ReceiptListItem {
  id: string;
  receipt_no: string;
  issued_at: string;
  voided_at: string | null;
  void_reason: string | null;
  tenantName: string;
  unitLabel: string;
  propertyName: string;
  amountMinor: number;
  amountWords: string;
  method: string;
}

function enrichMonth(ctx: Ctx, m: MonthStatus): EnrichedMonth {
  const tenancy = services(ctx).tenancy.getTenancy(m.tenancyId);
  return {
    ...m,
    tenantId: tenancy.tenant_id,
    tenantName: services(ctx).tenant.getTenant(tenancy.tenant_id).full_name,
    unitLabel: services(ctx).property.getUnit(tenancy.unit_id).label,
    propertyName: services(ctx).property.getProperty(tenancy.property_id).name,
    rentMinor: tenancy.current_rent_minor,
  };
}

function enrichPayment(ctx: Ctx, p: PaymentRow, liveReceiptPayments: Set<string>): EnrichedPayment {
  return {
    ...p,
    tenantName: services(ctx).tenant.getTenant(p.tenant_id).full_name,
    unitLabel: services(ctx).property.getUnit(p.unit_id).label,
    propertyName: services(ctx).property.getProperty(p.property_id).name,
    hasReceipt: liveReceiptPayments.has(p.id),
  };
}

function receiptListItem(r: ReceiptRow): ReceiptListItem {
  const snapshot: ReceiptSnapshot = JSON.parse(r.snapshot_json) as ReceiptSnapshot;
  return {
    id: r.id,
    receipt_no: r.receipt_no,
    issued_at: r.created_at,
    voided_at: r.voided_at,
    void_reason: r.void_reason,
    tenantName: snapshot.tenantName,
    unitLabel: snapshot.unitLabel,
    propertyName: snapshot.propertyName,
    amountMinor: snapshot.amountMinor,
    amountWords: snapshot.amountWords,
    method: snapshot.method,
  };
}

function liveReceiptPaymentIds(ctx: Ctx): Set<string> {
  const ids = new Set<string>();
  for (const r of services(ctx).receipt.listReceipts({ limit: 1000 })) {
    if (r.voided_at === null) ids.add(r.payment_id);
  }
  return ids;
}

// -- state payload ----------------------------------------------------------------

function statePayload(ctx: Ctx): Record<string, unknown> {
  if (!ctx.kitabu.isBootstrapped) {
    return { bootstrapped: false };
  }
  const org = services(ctx).organization.get();
  const device = ctx.kitabu.selfDevice();
  return {
    bootstrapped: true,
    org: {
      name: org.name,
      landlordName: org.landlord_name,
      kraPin: org.kra_pin,
      phone: org.phone,
      unitTerm: org.default_unit_term,
      currency: org.currency,
    },
    device: { name: device.name, platform: device.platform },
    users: services(ctx).organization.listUsers(),
    actingUserId: ctx.kitabu.actingUserId,
    today: new Date().toISOString().slice(0, 10),
    lastBackupAt: ctx.kitabu.localSetting('backup.last_exported_at'),
  };
}

// -- routing ----------------------------------------------------------------------

/** Escape hatch for binary responses (backup export). */
class RawResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;

  constructor(bytes: Uint8Array, contentType: string, filename: string) {
    this.bytes = bytes;
    this.contentType = contentType;
    this.filename = filename;
  }
}

type Handler = (
  ctx: Ctx,
  params: Record<string, string>,
  body: Record<string, unknown>,
  url: URL,
) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[]; // ':name' = parameter
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  routes.push({ method, segments: path.split('/').filter((s) => s !== ''), handler });
}

function matchRoute(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter((s) => s !== '');
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]!);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// -- static file serving (built web app) -------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(staticDir: string, pathname: string, res: ServerResponse): Promise<boolean> {
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  relative = normalize(relative).replace(/^([.][.][/\\])+/, '');
  const candidate = join(staticDir, relative);
  if (!candidate.startsWith(staticDir)) return false;
  let target = candidate;
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = join(target, 'index.html');
  } catch {
    // SPA fallback: client-side routes (e.g. /tenants/123) resolve to index.html
    target = join(staticDir, 'index.html');
  }
  try {
    const content = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// -- route definitions (built once at module load) ----------------------------------

defineRoutes();

function defineRoutes(): void {
  route('GET', '/api/state', (ctx) => statePayload(ctx));

  // Wipe this device's local database and start over (Settings → demo reset).
  route('POST', '/api/reset', (ctx) => {
    const options = ctx.options;
    if (ctx.kitabu.isBootstrapped) ctx.kitabu.close();
    if (options.dbPath !== undefined) rmSync(options.dbPath, { force: true });
    ctx.kitabu = options.dbPath !== undefined
      ? openKitabuFile(options.dbPath)
      : openKitabuInMemory();
    if (options.seedDemo === true) seedDemoData(ctx.kitabu);
    return statePayload(ctx);
  });

  // -- backups (FR-22 / NFR-09: local encrypted export + restore) --------------------

  // Export the whole live database as one passphrase-encrypted archive.
  // Owner-only (enforced in core); the browser saves the octet-stream as a file.
  route('POST', '/api/backup/export', (ctx, _p, body) => {
    const passphrase = str(body, 'passphrase') ?? '';
    const bytes = ctx.kitabu.exportBackup(passphrase);
    const today = new Date().toISOString().slice(0, 10);
    return new RawResponse(bytes, 'application/octet-stream', `kitabu-backup-${today}.kitabu`);
  });

  // Restore an archive onto this device. The passphrase is verified and the
  // snapshot fully validated BEFORE the current database is replaced — a wrong
  // passphrase never destroys existing data (NFR-09).
  route('POST', '/api/backup/restore', (ctx, _p, body) => {
    const passphrase = str(body, 'passphrase') ?? '';
    const backupBase64 = str(body, 'backupBase64') ?? '';
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(backupBase64);
    } catch {
      throw new KitabuError('VALIDATION', 'That file could not be read as a Kitabu backup.');
    }
    const crypto = new NodeCryptoPort();
    const snapshot = readBackup(bytes, passphrase, crypto); // throws friendly errors

    // Only now, with the backup fully verified, swap the local database.
    ctx.kitabu.close(); // also releases the file handle before rmSync (Windows)
    if (ctx.options.dbPath !== undefined) rmSync(ctx.options.dbPath, { force: true });
    const sqlite = ctx.options.dbPath !== undefined
      ? openNodeSqlite(ctx.options.dbPath)
      : openNodeSqlite(':memory:');
    ctx.kitabu = Kitabu.openFromSnapshot({ sqlite, crypto, snapshot });
    return statePayload(ctx);
  });

  route('POST', '/api/bootstrap', (ctx, _p, body) => {
    const result = ctx.kitabu.bootstrap({
      organizationName: str(body, 'organizationName') ?? '',
      landlordName: str(body, 'landlordName'),
      kraPin: str(body, 'kraPin'),
      phone: str(body, 'phone'),
      unitTerm: str(body, 'unitTerm'),
      deviceName: str(body, 'deviceName') ?? '',
      platform: (str(body, 'platform') ?? 'WINDOWS') as 'WINDOWS' | 'ANDROID',
    });
    ctx.kitabu.setActingUser(result.ctx.userId);
    return statePayload(ctx);
  });

  route('POST', '/api/acting-user', (ctx, _p, body) => {
    ctx.kitabu.setActingUser(str(body, 'userId') ?? null);
    return statePayload(ctx);
  });

  // -- dashboard -----------------------------------------------------------------

  route('GET', '/api/dashboard', (ctx) => {
    const month = currentMonth();
    const props = services(ctx).property.listProperties();
    const overview = services(ctx).ledger.monthOverview({ month }).map((m) => enrichMonth(ctx, m));
    const arrears: ArrearsRow[] = services(ctx).ledger.arrears();
    return {
      month,
      properties: props,
      totals: {
        properties: props.length,
        units: props.reduce((n, p) => n + p.unit_count, 0),
        occupied: props.reduce((n, p) => n + p.occupied_count, 0),
      },
      collection: services(ctx).ledger.collectionSummary({ month }),
      arrearsTotalMinor: arrears.reduce((n, a) => n + a.balanceMinor, 0),
      arrears,
      monthOverview: overview,
      pendingCount: services(ctx).payment.pending().length,
      recentAudit: services(ctx).audit.list({ limit: 8 }),
    };
  });

  // -- properties ------------------------------------------------------------------

  route('GET', '/api/properties', (ctx) => {
    return services(ctx).property.listProperties().map((p) => ({
      ...p,
      summary: services(ctx).property.summary(p.id),
      collection: services(ctx).ledger.collectionSummary({ propertyId: p.id }),
    }));
  });

  route('POST', '/api/properties', (ctx, _p, body) => {
    return {
      property: services(ctx).property.createProperty({
        name: str(body, 'name') ?? '',
        town: str(body, 'town'),
        estate: str(body, 'estate'),
        notes: str(body, 'notes'),
      }),
    };
  });

  route('GET', '/api/properties/:id', (ctx, params) => {
    const property = services(ctx).property.getProperty(params.id!);
    return {
      property,
      units: services(ctx).property.listUnits(params.id!),
      summary: services(ctx).property.summary(params.id!),
      collection: services(ctx).ledger.collectionSummary({ propertyId: params.id! }),
      arrears: services(ctx).ledger.arrears({ propertyId: params.id! }),
    };
  });

  route('POST', '/api/properties/:id/units', (ctx, params, body) => {
    return {
      unit: services(ctx).property.addUnit({
        propertyId: params.id!,
        label: str(body, 'label') ?? '',
        kind: str(body, 'kind') as UnitKind | undefined,
        notes: str(body, 'notes'),
      }),
    };
  });

  route('POST', '/api/units/:id/maintenance', (ctx, params, body) => {
    return { unit: services(ctx).property.setUnitMaintenance(params.id!, bool(body, 'on') === true) };
  });

  // -- tenants ---------------------------------------------------------------------

  route('GET', '/api/tenants', (ctx, _p, _b, url) => {
    const search = url.searchParams.get('search') ?? undefined;
    return services(ctx).tenant.listTenants({ search, includeArchived: false }).map((t) => {
      const tenancy = services(ctx).tenancy.activeTenancyForTenant(t.id);
      if (tenancy === null) {
        return { tenant: t, tenancy: null, unitLabel: null, propertyName: null, balanceMinor: null };
      }
      return {
        tenant: t,
        tenancy,
        unitLabel: services(ctx).property.getUnit(tenancy.unit_id).label,
        propertyName: services(ctx).property.getProperty(tenancy.property_id).name,
        balanceMinor: services(ctx).ledger.tenancyBalance(tenancy.id),
      };
    });
  });

  route('POST', '/api/tenants', (ctx, _p, body) => {
    return {
      tenant: services(ctx).tenant.registerTenant({
        fullName: str(body, 'fullName') ?? '',
        phone: str(body, 'phone'),
        altPhone: str(body, 'altPhone'),
        idNumber: str(body, 'idNumber'),
        email: str(body, 'email'),
        emergencyContact: str(body, 'emergencyContact'),
        notes: str(body, 'notes'),
      }),
    };
  });

  route('GET', '/api/tenants/:id', (ctx, params) => {
    const tenant = services(ctx).tenant.getTenant(params.id!);
    const history = services(ctx).tenancy.tenancyHistory(tenant.id);
    const active = services(ctx).tenancy.activeTenancyForTenant(tenant.id);
    if (active === null) return { tenant, history, active: null };
    return {
      tenant,
      history,
      active: {
        tenancy: active,
        unitLabel: services(ctx).property.getUnit(active.unit_id).label,
        propertyName: services(ctx).property.getProperty(active.property_id).name,
        balanceMinor: services(ctx).ledger.tenancyBalance(active.id),
        statement: services(ctx).ledger.statement(active.id),
        months: previousMonths(3).map((m) => services(ctx).ledger.monthStatus(active.id, m)),
        payments: services(ctx).payment.listPayments({ tenancyId: active.id, limit: 50 }),
      },
    };
  });

  route('POST', '/api/tenants/:id/tenancy', (ctx, params, body) => {
    return {
      tenancy: services(ctx).tenancy.startTenancy({
        tenantId: params.id!,
        unitId: str(body, 'unitId') ?? '',
        rentMinor: int(body, 'rentMinor') ?? 0,
        depositMinor: int(body, 'depositMinor'),
        startDate: str(body, 'startDate') ?? '',
        expectedPaymentDay: int(body, 'expectedPaymentDay'),
        notes: str(body, 'notes'),
      }),
    };
  });

  route('POST', '/api/tenancies/:id/end', (ctx, params, body) => {
    return {
      tenancy: services(ctx).tenancy.endTenancy(params.id!, str(body, 'endDate') ?? '', str(body, 'reason')),
    };
  });

  route('POST', '/api/tenancies/:id/change-rent', (ctx, params, body) => {
    return {
      rate: services(ctx).tenancy.changeRent(
        params.id!,
        int(body, 'rentMinor') ?? 0,
        str(body, 'effectiveFrom') ?? '',
        str(body, 'reason'),
      ),
    };
  });

  // -- ledger ----------------------------------------------------------------------

  route('POST', '/api/ledger/generate-charges', (ctx, _p, body) => {
    return services(ctx).ledger.generateMonthlyCharges(str(body, 'month') ?? '', {
      propertyId: str(body, 'propertyId'),
    });
  });

  route('GET', '/api/arrears', (ctx, _p, _b, url) => {
    return services(ctx).ledger.arrears({ propertyId: url.searchParams.get('propertyId') ?? undefined });
  });

  // -- payments --------------------------------------------------------------------

  route('GET', '/api/payments', (ctx, _p, _b, url) => {
    const status = url.searchParams.get('status') ?? undefined;
    const tenancyId = url.searchParams.get('tenancyId') ?? undefined;
    const live = liveReceiptPaymentIds(ctx);
    return services(ctx).payment
      .listPayments({ status: status as PaymentRow['status'] | undefined, tenancyId, limit: 300 })
      .map((p) => enrichPayment(ctx, p, live));
  });

  route('POST', '/api/payments', (ctx, _p, body) => {
    const payment = services(ctx).payment.recordPayment({
      tenancyId: str(body, 'tenancyId') ?? '',
      amountMinor: int(body, 'amountMinor') ?? 0,
      method: (str(body, 'method') ?? 'CASH') as 'CASH' | 'MPESA' | 'BANK' | 'OTHER',
      paidAt: str(body, 'paidAt') ?? '',
      reference: str(body, 'reference'),
      payerName: str(body, 'payerName'),
    });
    return { payment: enrichPayment(ctx, payment, liveReceiptPaymentIds(ctx)) };
  });

  route('POST', '/api/payments/:id/verify', (ctx, params, body) => {
    return { payment: services(ctx).payment.verifyPayment(params.id!, str(body, 'note')) };
  });

  route('POST', '/api/payments/:id/reject', (ctx, params, body) => {
    return { payment: services(ctx).payment.rejectPayment(params.id!, str(body, 'reason') ?? '') };
  });

  route('POST', '/api/payments/:id/reverse', (ctx, params, body) => {
    return services(ctx).payment.reversePayment(params.id!, str(body, 'reason') ?? '');
  });

  // -- receipts --------------------------------------------------------------------

  route('GET', '/api/receipts', (ctx, _p, _b, url) => {
    const includeVoided = url.searchParams.get('includeVoided') === '1';
    const propertyId = url.searchParams.get('propertyId') ?? undefined;
    return services(ctx).receipt
      .listReceipts({ includeVoided, propertyId, limit: 300 })
      .map((r) => receiptListItem(r));
  });

  route('POST', '/api/receipts', (ctx, _p, body) => {
    const result = services(ctx).receipt.issueReceipt(str(body, 'paymentId') ?? '');
    return { receipt: result.receipt, snapshot: result.snapshot };
  });

  route('GET', '/api/receipts/:id', (ctx, params) => {
    const receipt = services(ctx).receipt.getReceipt(params.id!);
    const integrity: ReceiptIntegrity = services(ctx).receipt.verifyReceiptIntegrity(receipt);
    return { receipt, snapshot: JSON.parse(receipt.snapshot_json) as ReceiptSnapshot, integrity };
  });

  route('POST', '/api/receipts/:id/void', (ctx, params, body) => {
    return { receipt: services(ctx).receipt.voidReceipt(params.id!, str(body, 'reason') ?? '') };
  });

  route('POST', '/api/receipts/:id/reissue', (ctx, params, body) => {
    const result = services(ctx).receipt.reissueReceipt(params.id!, str(body, 'reason') ?? '');
    return { voided: result.voided, receipt: result.reissued.receipt, snapshot: result.reissued.snapshot };
  });

  // -- audit -----------------------------------------------------------------------

  route('GET', '/api/audit', (ctx, _p, _b, url) => {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    return services(ctx).audit.list({ limit: Math.min(Math.max(limit, 1), 200) });
  });

  // -- users & organization ----------------------------------------------------------

  route('GET', '/api/users', (ctx) => services(ctx).organization.listUsers());

  route('POST', '/api/users', (ctx, _p, body) => {
    return {
      user: services(ctx).organization.addUser({
        fullName: str(body, 'fullName') ?? '',
        role: (str(body, 'role') ?? 'CARETAKER') as 'OWNER' | 'MANAGER' | 'CARETAKER',
        phone: str(body, 'phone'),
      }),
    };
  });

  route('POST', '/api/organization', (ctx, _p, body) => {
    services(ctx).organization.update({
      name: str(body, 'name'),
      landlordName: str(body, 'landlordName'),
      kraPin: str(body, 'kraPin'),
      phone: str(body, 'phone'),
      unitTerm: str(body, 'unitTerm'),
    });
    return statePayload(ctx);
  });
}

// -- server -----------------------------------------------------------------------

export function createApiServer(options: ApiOptions = {}): ApiServer {
  const kitabu = options.dbPath !== undefined
    ? openKitabuFile(options.dbPath)
    : openKitabuInMemory();

  if (options.seedDemo === true && !kitabu.isBootstrapped) {
    seedDemoData(kitabu);
  }

  const ctx: Ctx = { kitabu, options };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) {
        const matched = matchRoute(req.method ?? 'GET', url.pathname);
        if (matched === null) throw new KitabuError('NOT_FOUND', 'That screen does not exist.');
        applyActingUser(ctx, req);
        const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
        const result = await matched.handler(ctx, matched.params, body, url);
        if (result instanceof RawResponse) {
          res.writeHead(200, {
            'content-type': result.contentType,
            'content-length': String(result.bytes.length),
            'content-disposition': `attachment; filename="${result.filename}"`,
            'cache-control': 'no-store',
          });
          res.end(Buffer.from(result.bytes));
          return;
        }
        json(res, 200, result ?? { ok: true });
        return;
      }
      if (options.staticDir !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
        if (await serveStatic(options.staticDir, url.pathname, res)) return;
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    } catch (err) {
      if (err instanceof KitabuError) {
        json(res, HTTP_BY_CODE[err.code] ?? 400, { error: { code: err.code, message: err.userMessage } });
        return;
      }
      // Unexpected: never leak internals to the UI (docs/UX.md §5).
      console.error('[kitabu-api]', err);
      json(res, 500, {
        error: {
          code: 'INTERNAL',
          message: 'Something went wrong on this device. Your data is safe — nothing was changed.',
        },
      });
    }
  }

  return {
    server,
    /** Live reference — a demo reset swaps in a fresh database. */
    get kitabu(): Kitabu { return ctx.kitabu; },
    port: () => {
      const addr = server.address();
      return typeof addr === 'object' && addr !== null ? addr.port : 0;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ctx.kitabu.isBootstrapped) ctx.kitabu.close();
    },
  };
}

/** Wipe the local database and start fresh (Settings → demo reset). */
export function resetApiServer(api: ApiServer, options: ApiOptions): ApiServer {
  if (api.kitabu.isBootstrapped) api.kitabu.close();
  if (options.dbPath !== undefined) rmSync(options.dbPath, { force: true });
  const fresh = createApiServer(options);
  return fresh;
}
