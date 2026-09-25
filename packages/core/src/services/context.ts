/**
 * ServiceContext — everything a service needs to run (hexagonal style).
 * `userId` is the acting user (set after unlock in app shells; null = device action).
 */

import type { SqlitePort } from '../db/port.ts';
import type { Clock } from '../foundation/clock.ts';
import type { HybridLogicalClock } from '../foundation/hlc.ts';
import type { UserRole } from '../domain/types.ts';
import { permissionError } from '../foundation/errors.ts';

export interface ServiceContext {
  readonly db: SqlitePort;
  readonly clock: Clock;
  readonly hlcClock: HybridLogicalClock;
  /** This device's id (row in `devices`). */
  readonly deviceId: string;
  /** Active organization id. */
  readonly orgId: string;
  /** Acting user (owner/manager/caretaker) or null for device-level actions. */
  userId: string | null;
}

/** Read the acting user's role for permission checks (SECURITY.md §3). */
export function currentUserRole(ctx: ServiceContext): UserRole | null {
  if (ctx.userId === null) return null;
  const row = ctx.db
    .prepare('SELECT role FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
    .get(ctx.userId, ctx.orgId) as { role: UserRole } | undefined;
  return row?.role ?? null;
}

/**
 * Enforce a role requirement in the service layer (never only in the UI).
 * Throws a friendly PERMISSION error naming the needed role.
 */
export function requireRole(ctx: ServiceContext, allowed: readonly UserRole[], actionLabel: string): UserRole {
  const role = currentUserRole(ctx);
  if (role === null || !allowed.includes(role)) {
    const needed = allowed.join(' or ').toLowerCase();
    const article = 'aeiou'.includes(needed.charAt(0)) ? 'an' : 'a';
    throw permissionError(
      `Only ${article} ${needed} can ${actionLabel}. Ask the landlord to do this on their device.`,
      `requireRole(${allowed.join('|')}) failed for action ${actionLabel}; actor=${ctx.userId ?? 'device'}`,
    );
  }
  return role;
}
