/**
 * ServiceContext — everything a service needs to run (hexagonal style).
 * `userId` is the acting user (set after unlock in app shells; null = device action).
 */

import type { SqlitePort } from '../db/port.ts';
import type { Clock } from '../foundation/clock.ts';
import type { HybridLogicalClock } from '../foundation/hlc.ts';

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

/** Read the acting user's role for permission checks (M2+ enforces deeply). */
export function currentUserRole(ctx: ServiceContext): 'OWNER' | 'MANAGER' | 'CARETAKER' | null {
  if (ctx.userId === null) return null;
  const row = ctx.db
    .prepare('SELECT role FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
    .get(ctx.userId, ctx.orgId) as { role: 'OWNER' | 'MANAGER' | 'CARETAKER' } | undefined;
  return row?.role ?? null;
}
