import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { newId } from '@kitabu/core';
import { AppError, ensureDevice, getSetting, insertRow, nowIso, setSetting, type Ctx, type DB } from '../db/index.js';

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}
export function verifyPin(pin: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return scryptSync(pin, salt, 32).toString('hex') === hash;
}

export interface SetupInput {
  ownerName: string;
  pin?: string;
  orgName: string;
  terminology?: string;
  propertyName: string;
  location?: string;
  units: { label: string; rentMinor: number; depositMinor?: number }[];
}

/** First-run onboarding: org + owner + device + first property + units. Fully offline. */
export function runSetup(db: DB, input: SetupInput) {
  if (getSetting(db, 'org_id')) throw new AppError('This device is already set up.');
  if (!input.ownerName.trim()) throw new AppError('Please enter your name.');
  if (!input.orgName.trim()) throw new AppError('Please enter your business name.');
  if (!input.propertyName.trim()) throw new AppError('Please enter a property name.');
  if (!input.units.length) throw new AppError('Add at least one house/unit.');

  const { deviceId, deviceCode } = ensureDevice(db);
  const orgId = newId('org');
  const userId = newId('usr');

  const ctx: Ctx = { db, orgId, userId, userRole: 'OWNER', deviceId, deviceCode };

  const tx = db.transaction(() => {
    insertRow(ctx, 'organizations', {
      id: orgId, name: input.orgName.trim(),
      terminology: input.terminology || 'House', currency: 'KES', settings_json: '{}',
    });
    insertRow(ctx, 'users', {
      id: userId, org_id: orgId, full_name: input.ownerName.trim(), phone: null,
      role: 'OWNER', pin_hash: input.pin ? hashPin(input.pin) : null, status: 'ACTIVE',
    });
    insertRow(ctx, 'devices', {
      id: deviceId, org_id: orgId, name: 'This device', platform: process.platform,
      device_code: deviceCode, public_key: null, status: 'ACTIVE', paired_at: nowIso(), last_sync_at: null,
    });
    const propId = newId('prop');
    insertRow(ctx, 'properties', {
      id: propId, org_id: orgId, name: input.propertyName.trim(),
      location: input.location?.trim() || null, notes: null,
    });
    for (const u of input.units) {
      insertRow(ctx, 'units', {
        id: newId('unit'), org_id: orgId, property_id: propId, building_id: null,
        label: u.label, monthly_rent_minor: u.rentMinor, deposit_minor: u.depositMinor ?? 0, status: 'VACANT',
      });
    }
    setSetting(db, 'org_id', orgId);
    setSetting(db, 'user_id', userId);
    setSetting(db, 'receipt_seq', '0');
  });
  tx();
  return { orgId, userId };
}

/** Resolve the acting context for this local device (single-profile v1). */
export function getCtx(db: DB): Ctx | null {
  const orgId = getSetting(db, 'org_id');
  const userId = getSetting(db, 'user_id');
  if (!orgId || !userId) return null;
  const { deviceId, deviceCode } = ensureDevice(db);
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: Ctx['userRole'] } | undefined;
  return { db, orgId, userId, userRole: user?.role ?? 'OWNER', deviceId, deviceCode };
}

export function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
