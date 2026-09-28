/**
 * Device pairing + sync sessions (docs/SYNC.md §3–4).
 *
 * Pairing: the landlord's device shows a short one-time code + its local
 * address; the joining device (same Wi-Fi / hotspot) submits the code and
 * receives the organization's full change history plus its device identity.
 *
 * Sync session: pull peer's changes since our cursor, apply idempotently,
 * then push our changes since THEIR cursor for us. Either side may initiate.
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { newDeviceCode, newId } from '@kitabu/core';
import { AppError, getSetting, insertRow, nowIso, setSetting, type Ctx, type DB } from '../db/index.js';
import { getCtx } from '../services/setup.js';
import {
  advancePeerCursor, applyChanges, assertDeviceAllowed, getChangesSince,
  getPeerCursor, maxSeq, SYNC_BATCH, type ApplyResult, type SyncChange,
} from './engine.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;

export function getSyncKey(db: DB): string {
  let key = getSetting(db, 'sync_key');
  if (!key) {
    key = randomBytes(24).toString('hex');
    setSetting(db, 'sync_key', key);
  }
  return key;
}

export function localAddresses(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`${ni.address}:${port}`);
    }
  }
  out.push(`localhost:${port}`);
  return out;
}

// ---------------------------------------------------------------- pairing --
export function createPairing(ctx: Ctx, port: number) {
  if (ctx.userRole !== 'OWNER') throw new AppError('Only the owner can add devices.', 403);
  const code = randomBytes(3).toString('hex').toUpperCase(); // e.g. 9F3A1C
  setSetting(ctx.db, 'pairing_code', code);
  setSetting(ctx.db, 'pairing_expires', String(Date.now() + PAIRING_TTL_MS));
  return { code, addresses: localAddresses(port), expiresInMinutes: PAIRING_TTL_MS / 60000 };
}

export interface JoinBundle {
  orgId: string;
  orgName: string;
  deviceId: string;
  deviceCode: string;
  ownerUserId: string;
  landlordDeviceId: string;
  syncKey: string;
  changes: SyncChange[];
}

/** Runs ON THE LANDLORD'S device when a new device submits the pairing code. */
export function handleJoin(db: DB, input: { code: string; deviceName: string; platform?: string }): JoinBundle {
  const ctx = getCtx(db);
  if (!ctx) throw new AppError('This Kitabu is not set up yet.', 409);
  const code = getSetting(db, 'pairing_code');
  const expires = Number(getSetting(db, 'pairing_expires') || 0);
  if (!code || !input.code || input.code.trim().toUpperCase() !== code || Date.now() > expires) {
    throw new AppError('That pairing code is wrong or has expired. Generate a new one on the main device.');
  }
  setSetting(db, 'pairing_code', ''); // single-use

  const deviceId = newId('dev');
  const deviceCode = newDeviceCode();
  insertRow(ctx, 'devices', {
    id: deviceId, org_id: ctx.orgId, name: input.deviceName?.trim() || 'New device',
    platform: input.platform || 'unknown', device_code: deviceCode, public_key: null,
    status: 'ACTIVE', paired_at: nowIso(), last_sync_at: null,
  });
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(ctx.orgId) as any;

  return {
    orgId: ctx.orgId,
    orgName: org?.name ?? '',
    deviceId,
    deviceCode,
    ownerUserId: ctx.userId,
    landlordDeviceId: ctx.deviceId,
    syncKey: getSyncKey(db),
    changes: getChangesSince(db, 0, 1_000_000),
  };
}

/** Runs ON THE JOINING device: adopt identity + replay the org's history. */
export function applyJoinBundle(db: DB, bundle: JoinBundle, landlordAddress: string) {
  if (getSetting(db, 'org_id')) throw new AppError('This device is already set up.');
  setSetting(db, 'device_id', bundle.deviceId);
  setSetting(db, 'device_code', bundle.deviceCode);
  setSetting(db, 'org_id', bundle.orgId);
  setSetting(db, 'user_id', bundle.ownerUserId);
  setSetting(db, 'sync_key', bundle.syncKey);
  setSetting(db, 'receipt_seq', '0');

  const ctx = getCtx(db)!;
  const res = applyChanges(ctx, bundle.changes);
  const last = bundle.changes.length ? bundle.changes[bundle.changes.length - 1]!.seq : 0;
  advancePeerCursor(db, bundle.landlordDeviceId, last, 'Main device', landlordAddress);
  return { ...res, orgName: bundle.orgName };
}

// ------------------------------------------------------------ sync session --
/** Transport abstraction: HTTP for real peers, direct for tests. */
export interface PeerTransport {
  hello(): Promise<{ deviceId: string; deviceName: string; orgId: string; cursorForYou: number }>;
  getChanges(after: number, limit: number): Promise<SyncChange[]>;
  apply(changes: SyncChange[]): Promise<ApplyResult>;
}

export interface SyncSummary {
  peerDeviceId: string;
  pulled: ApplyResult;
  pushed: number;
}

export async function performSync(ctx: Ctx, transport: PeerTransport, peerAddress?: string): Promise<SyncSummary> {
  const hello = await transport.hello();
  if (hello.orgId !== ctx.orgId) throw new AppError('That device belongs to a different organization and cannot sync with this one.', 403);
  assertDeviceAllowed(ctx.db, hello.deviceId);

  // 1) PULL: peer's changes since our cursor for them
  const pulled: ApplyResult = { applied: 0, skipped: 0, conflicts: 0 };
  for (;;) {
    const cursor = getPeerCursor(ctx.db, hello.deviceId);
    const changes = await transport.getChanges(cursor, SYNC_BATCH);
    if (changes.length === 0) break;
    const r = applyChanges(ctx, changes);
    pulled.applied += r.applied; pulled.skipped += r.skipped; pulled.conflicts += r.conflicts;
    advancePeerCursor(ctx.db, hello.deviceId, changes[changes.length - 1]!.seq, hello.deviceName, peerAddress);
    if (changes.length < SYNC_BATCH) break;
  }
  advancePeerCursor(ctx.db, hello.deviceId, getPeerCursor(ctx.db, hello.deviceId), hello.deviceName, peerAddress);

  // 2) PUSH: our changes since the peer's cursor for us
  let pushed = 0;
  let after = hello.cursorForYou;
  for (;;) {
    const out = getChangesSince(ctx.db, after, SYNC_BATCH);
    if (out.length === 0) break;
    await transport.apply(out);
    pushed += out.length;
    after = out[out.length - 1]!.seq;
    if (out.length < SYNC_BATCH) break;
  }

  ctx.db.prepare('UPDATE devices SET last_sync_at = ? WHERE id IN (?, ?)').run(nowIso(), ctx.deviceId, hello.deviceId);
  return { peerDeviceId: hello.deviceId, pulled, pushed };
}

/** What the PEER runs when it receives an /apply push from another device. */
export function receivePush(db: DB, fromDeviceId: string, changes: SyncChange[]): ApplyResult {
  const ctx = getCtx(db);
  if (!ctx) throw new AppError('Not set up.', 409);
  assertDeviceAllowed(db, fromDeviceId);
  const res = applyChanges(ctx, changes);
  if (changes.length) {
    const peer = db.prepare('SELECT name FROM devices WHERE id = ?').get(fromDeviceId) as any;
    advancePeerCursor(db, fromDeviceId, changes[changes.length - 1]!.seq, peer?.name);
  }
  return res;
}

// -------------------------------------------------------------- transports --
export function httpTransport(address: string, selfDeviceId: string, syncKey: string): PeerTransport {
  const base = `http://${address.replace(/^https?:\/\//, '')}/api/sync`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Kitabu-Device': selfDeviceId,
    'X-Kitabu-Key': syncKey,
  };
  const call = async (path: string, init?: RequestInit) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${base}${path}`, { ...init, headers, signal: ctrl.signal });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new AppError(body.error || `The other device replied with an error (${res.status}).`, 502);
      return body;
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      throw new AppError('Could not reach the other device. Make sure both devices are on the same Wi-Fi or hotspot and Kitabu is open.', 502);
    } finally { clearTimeout(t); }
  };
  return {
    hello: () => call('/hello'),
    getChanges: (after, limit) => call(`/changes?after=${after}&limit=${limit}`).then((b: any) => b.changes),
    apply: (changes) => call('/apply', { method: 'POST', body: JSON.stringify({ changes }) }),
  };
}

/** Direct in-process transport — used by the automated sync tests. */
export function directTransport(peerDb: DB, callerDeviceId: string): PeerTransport {
  return {
    hello: async () => {
      const ctx = getCtx(peerDb)!;
      assertDeviceAllowed(peerDb, callerDeviceId);
      const dev = peerDb.prepare('SELECT name FROM devices WHERE id = ?').get(ctx.deviceId) as any;
      return {
        deviceId: ctx.deviceId,
        deviceName: dev?.name ?? 'Peer',
        orgId: ctx.orgId,
        cursorForYou: getPeerCursor(peerDb, callerDeviceId),
      };
    },
    getChanges: async (after, limit) => {
      assertDeviceAllowed(peerDb, callerDeviceId);
      return getChangesSince(peerDb, after, limit);
    },
    apply: async (changes) => receivePush(peerDb, callerDeviceId, changes),
  };
}
