/**
 * Audit service — read access to the append-only audit trail (brief §52).
 * Entries are written by `appendAudit` inside every service mutation.
 */

import type { ServiceContext } from './context.ts';
import type { AuditLogRow } from '../domain/types.ts';

export class AuditService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  list(input: {
    limit?: number;
    offset?: number;
    entityType?: string;
    entityId?: string;
  } = {}): AuditLogRow[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const offset = Math.max(input.offset ?? 0, 0);
    if (input.entityType !== undefined && input.entityId !== undefined) {
      return this.ctx.db
        .prepare(
          `SELECT * FROM audit_log WHERE org_id = ? AND entity_type = ? AND entity_id = ?
           ORDER BY occurred_at DESC, id ASC LIMIT ? OFFSET ?`,
        )
        .all(this.ctx.orgId, input.entityType, input.entityId, limit, offset) as AuditLogRow[];
    }
    return this.ctx.db
      .prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY occurred_at DESC, id ASC LIMIT ? OFFSET ?')
      .all(this.ctx.orgId, limit, offset) as AuditLogRow[];
  }

  /** Count of audit entries — used by tests and the sync screen (M5). */
  count(): number {
    const row = this.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?')
      .get(this.ctx.orgId) as { n: number };
    return row.n;
  }
}
