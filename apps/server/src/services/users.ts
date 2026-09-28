/**
 * Staff & device lock (docs/SECURITY.md §2–3).
 * One device carries one "current user"; the lock screen switches between the
 * organization's users, each protected by their own PIN. Roles are enforced in
 * the services (never only in the UI): caretaker cash lands PENDING, caretakers
 * cannot verify payments, see reports, or manage devices.
 */
import { newId, normalizeKenyanPhone, type Role } from '@kitabu/core';
import { AppError, audit, getSetting, insertRow, setSetting, updateRow, type Ctx, type DB } from '../db/index.js';
import { hashPin, verifyPin } from './setup.js';

export function listUsers(ctx: Ctx) {
  return ctx.db.prepare(
    `SELECT id, full_name, phone, role, status,
            CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END has_pin
       FROM users WHERE org_id = ? AND deleted_at IS NULL ORDER BY role, full_name`,
  ).all(ctx.orgId);
}

/** Safe list for the lock screen (no ctx — the device is locked). */
export function lockScreenUsers(db: DB) {
  const orgId = getSetting(db, 'org_id');
  if (!orgId) return [];
  return db.prepare(
    `SELECT id, full_name, role, CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END has_pin
       FROM users WHERE org_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY role, full_name`,
  ).all(orgId);
}

export function createUser(ctx: Ctx, input: { fullName: string; phone?: string; role: Role; pin?: string }) {
  if (ctx.userRole !== 'OWNER') throw new AppError('Only the owner can add staff.', 403);
  if (!input.fullName?.trim()) throw new AppError('Enter the staff member\u2019s name.');
  if (!['MANAGER', 'CARETAKER'].includes(input.role)) throw new AppError('Choose a role: Manager or Caretaker.');
  if (input.pin && !/^\d{4,8}$/.test(input.pin)) throw new AppError('A PIN must be 4\u20138 digits.');
  let phone: string | null = null;
  if (input.phone?.trim()) {
    phone = normalizeKenyanPhone(input.phone);
    if (!phone) throw new AppError('That phone number does not look right.');
  }
  const id = newId('usr');
  ctx.db.transaction(() => {
    insertRow(ctx, 'users', {
      id, org_id: ctx.orgId, full_name: input.fullName.trim(), phone,
      role: input.role, pin_hash: input.pin ? hashPin(input.pin) : null, status: 'ACTIVE',
    });
    audit(ctx, 'user.created', 'users', id, undefined, { name: input.fullName, role: input.role });
  })();
  return { id };
}

export function setUserPin(ctx: Ctx, userId: string, pin: string) {
  if (ctx.userRole !== 'OWNER' && ctx.userId !== userId) throw new AppError('You can only change your own PIN.', 403);
  if (!/^\d{4,8}$/.test(pin)) throw new AppError('A PIN must be 4\u20138 digits.');
  ctx.db.transaction(() => {
    updateRow(ctx, 'users', userId, { pin_hash: hashPin(pin) });
    audit(ctx, 'user.pin_changed', 'users', userId);
  })();
}

export function deactivateUser(ctx: Ctx, userId: string) {
  if (ctx.userRole !== 'OWNER') throw new AppError('Only the owner can deactivate staff.', 403);
  if (userId === ctx.userId) throw new AppError('You cannot deactivate yourself.');
  ctx.db.transaction(() => {
    updateRow(ctx, 'users', userId, { status: 'DISABLED' });
    audit(ctx, 'user.deactivated', 'users', userId);
  })();
}

// ------------------------------------------------------------- lock/login --
export function isLocked(db: DB): boolean {
  return getSetting(db, 'locked') === '1';
}

export function lockDevice(db: DB): void {
  setSetting(db, 'locked', '1');
}

export function loginUser(db: DB, input: { userId: string; pin?: string }) {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE' AND deleted_at IS NULL").get(input.userId) as any;
  if (!u) throw new AppError('That user was not found on this device.', 404);
  if (u.pin_hash) {
    if (!input.pin || !verifyPin(input.pin, u.pin_hash)) throw new AppError('Wrong PIN. Try again.', 401);
  }
  setSetting(db, 'user_id', u.id);
  setSetting(db, 'locked', '0');
  return { id: u.id, fullName: u.full_name, role: u.role };
}
