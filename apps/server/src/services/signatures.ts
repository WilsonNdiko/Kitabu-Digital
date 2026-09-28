/**
 * Digital signatures (docs/PRD F8, brief §19).
 * A signature image is attached per organization (default) or per property.
 * Receipts embed the signature IN THEIR SNAPSHOT at issuance — replacing the
 * signature later never changes receipts that were already issued.
 */
import { newId } from '@kitabu/core';
import { AppError, audit, insertRow, nowIso, updateRow, type Ctx } from '../db/index.js';
import { contentHash } from './setup.js';

const MAX_DATA_URL = 400_000; // ~300 KB image

export function setSignature(ctx: Ctx, input: { dataUrl: string; propertyId?: string | null }) {
  if (ctx.userRole !== 'OWNER') throw new AppError('Only the owner can change the signature.', 403);
  const dataUrl = input.dataUrl?.trim() ?? '';
  if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new AppError('Upload a PNG or JPG image of the signature.');
  }
  if (dataUrl.length > MAX_DATA_URL) throw new AppError('That image is too large. Use a smaller photo (under ~300 KB).');
  const propertyId = input.propertyId || null;
  if (propertyId) {
    const p = ctx.db.prepare('SELECT id FROM properties WHERE id = ? AND org_id = ?').get(propertyId, ctx.orgId);
    if (!p) throw new AppError('Property not found.', 404);
  }

  const id = newId('sig');
  ctx.db.transaction(() => {
    // retire the current signature for this scope (history retained, synced)
    const current = ctx.db.prepare(
      `SELECT id FROM signatures WHERE org_id = ? AND active = 1 AND ${propertyId ? 'property_id = ?' : 'property_id IS NULL'}`,
    ).all(...(propertyId ? [ctx.orgId, propertyId] : [ctx.orgId])) as any[];
    for (const s of current) updateRow(ctx, 'signatures', s.id, { active: 0 });

    insertRow(ctx, 'signatures', {
      id, org_id: ctx.orgId, property_id: propertyId, image_data: dataUrl,
      sha256: contentHash(dataUrl), active: 1, created_at: nowIso(),
    });
    audit(ctx, 'signature.updated', 'signatures', id, undefined, { propertyId });
  })();
  return { id };
}

/** Property-specific signature if set, else the organization default. */
export function getActiveSignature(ctx: Ctx, propertyId?: string | null): { dataUrl: string; sha256: string } | null {
  const byScope = (pid: string | null) =>
    ctx.db.prepare(
      `SELECT image_data, sha256 FROM signatures
        WHERE org_id = ? AND active = 1 AND ${pid ? 'property_id = ?' : 'property_id IS NULL'}
        ORDER BY created_at DESC LIMIT 1`,
    ).get(...(pid ? [ctx.orgId, pid] : [ctx.orgId])) as any;
  const row = (propertyId ? byScope(propertyId) : null) ?? byScope(null);
  return row ? { dataUrl: row.image_data, sha256: row.sha256 } : null;
}

export function signatureStatus(ctx: Ctx) {
  const org = getActiveSignature(ctx, null);
  return { hasSignature: !!org, dataUrl: org?.dataUrl ?? null };
}
