/**
 * Receipt service — numbering, immutable snapshots, signatures, tamper-evidence
 * (docs/RECEIPTS.md).
 *
 * - Numbers come from per-device reserved blocks per organization (R-000123),
 *   allocated lazily: first device takes 1–500, later devices continue from the
 *   highest granted block end. Numbers are never reused, even after voiding.
 * - The receipt snapshot freezes every displayed value at issuance; later tenant
 *   renames or rent changes never alter an issued receipt.
 * - Tamper evidence: digest = sha256(canonical JSON of the snapshot) +
 *   Ed25519 signature of the digest by the organization receipt key (generated
 *   once per org, shared to paired devices via sync).
 */

import type { ServiceContext } from './context.ts';
import { requireRole } from './context.ts';
import { appendAudit, recordOp, stampNew, stampUpdate } from './mutations.ts';
import { insertRow, updateRow } from '../db/crud.ts';
import type {
  OrganizationRow, PaymentRow, ReceiptNumberBlockRow, ReceiptRow, SignatureImageRow, TenancyRow,
} from '../domain/types.ts';
import type { CryptoPort } from '../foundation/crypto.ts';
import { domainRule, validationError } from '../foundation/errors.ts';
import { base64ToBytes, bytesToBase64 } from '../foundation/base64.ts';
import { canonicalJson } from '../foundation/canonicaljson.ts';
import { sha256HexOfUtf8, utf8Bytes } from '../foundation/sha256.ts';
import { shillingsInWords } from '../foundation/numwords.ts';
import { formatKsh } from '../foundation/money.ts';

export const RECEIPT_BLOCK_SIZE = 500;

export interface IssueReceiptResult {
  receipt: ReceiptRow;
  snapshot: ReceiptSnapshot;
}

export interface ReceiptSnapshot {
  receiptNo: string;
  issuedAt: string;
  orgName: string;
  landlordName: string | null;
  kraPin: string | null;
  currency: string;
  propertyName: string;
  propertyLocation: string;
  tenantName: string;
  unitLabel: string;
  paymentId: string;
  amountMinor: number;
  amountWords: string;
  paidAt: string;
  method: string;
  reference: string | null;
  periods: string[];
  primaryPeriod: string | null;
  previousBalanceMinor: number;
  remainingBalanceMinor: number;
  signatureLabel: string | null;
  signatureDigest: string | null;
  issuedBy: string | null;
  deviceName: string;
}

export interface ReceiptIntegrity {
  ok: boolean;
  digestMatches: boolean;
  signatureValid: boolean | null; // null = no crypto signature on the receipt
}

export class ReceiptService {
  readonly ctx: ServiceContext;
  readonly #crypto: CryptoPort | undefined;

  constructor(ctx: ServiceContext, crypto?: CryptoPort) {
    this.ctx = ctx;
    this.#crypto = crypto;
  }

  // -- signatures --------------------------------------------------------------

  /**
   * Register a signature image for the organization (propertyId null) or a specific
   * property. Replaces the active one for that scope; issued receipts are unaffected
   * (they froze the digest at issuance).
   */
  registerSignature(input: {
    propertyId?: string;
    label?: string;
    /** sha256 hex of the image bytes (content-addressed; blobs land with documents in M4). */
    imageDigest: string;
    imageRef?: string;
  }): SignatureImageRow {
    requireRole(this.ctx, ['OWNER'], 'change the receipt signature');
    if (!/^[0-9a-f]{64}$/.test(input.imageDigest)) {
      throw validationError('The signature image digest is missing or invalid.');
    }

    return this.ctx.db.transaction(() => {
      let propertyId: string | null = null;
      if (input.propertyId !== undefined && input.propertyId !== null) {
        const property = this.ctx.db
          .prepare('SELECT id, name FROM properties WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
          .get(input.propertyId, this.ctx.orgId) as { id: string; name: string } | undefined;
        if (property === undefined) throw domainRule('Property not found.');
        propertyId = property.id;
      }

      // Close the currently active signature for this scope.
      const active = this.#activeSignature(propertyId);
      if (active !== null) {
        stampUpdate(this.ctx, active);
        active.active_to = this.ctx.clock.nowIso();
        updateRow(this.ctx.db, 'signature_images', active);
        recordOp(this.ctx, 'signature_images', active);
      }

      const stamp = stampNew(this.ctx);
      const row: SignatureImageRow = {
        ...stamp,
        property_id: propertyId,
        label: input.label?.trim() || 'Signature',
        image_ref: input.imageRef?.trim() || `sha256:${input.imageDigest}`,
        image_digest: input.imageDigest,
        active_from: this.ctx.clock.nowIso(),
        active_to: null,
        created_by_user_id: this.ctx.userId,
      };
      insertRow(this.ctx.db, 'signature_images', row);
      recordOp(this.ctx, 'signature_images', row);

      appendAudit(this.ctx, {
        action: 'SIGNATURE_SET',
        entityType: 'signature_image',
        entityId: row.id,
        summary: `Signature "${row.label}" set${propertyId === null ? ' as organization default' : ' for this property'}.`,
        after: { ...row },
      });
      return row;
    });
  }

  activeSignature(propertyId?: string): SignatureImageRow | null {
    return this.#activeSignature(propertyId ?? null);
  }

  #activeSignature(propertyId: string | null): SignatureImageRow | null {
    // Property-specific first, then organization default (RECEIPTS.md §4).
    for (const scope of propertyId === null ? [null] : [propertyId, null]) {
      const row = this.ctx.db
        .prepare(
          `SELECT * FROM signature_images
           WHERE org_id = ? AND property_id IS ? AND active_to IS NULL AND deleted_at IS NULL
           ORDER BY active_from DESC LIMIT 1`,
        )
        .get(this.ctx.orgId, scope) as SignatureImageRow | undefined;
      if (row !== undefined) return row;
    }
    return null;
  }

  // -- issuance ------------------------------------------------------------------

  /**
   * Issue a receipt for a VERIFIED payment. Assembles the snapshot from system data
   * (nothing re-typed), freezes it, digests it, signs it. Owner-only in M2.
   */
  issueReceipt(paymentId: string, input: { signatureId?: string } = {}): IssueReceiptResult {
    requireRole(this.ctx, ['OWNER'], 'issue a receipt');

    return this.ctx.db.transaction(() => this.#issueReceiptTx(paymentId, input));
  }

  /**
   * Issue a receipt inside the caller's transaction (so void + reissue is atomic).
   * `reissueReceipt` uses this to avoid nesting transactions.
   */
  #issueReceiptTx(paymentId: string, input: { signatureId?: string }): IssueReceiptResult {
    {
      const payment = this.#payment(paymentId);
      if (payment.status === 'PENDING' || payment.status === 'VERIFYING') {
        throw domainRule('This payment is not verified yet. The receipt becomes available after verification.');
      }
      if (payment.status === 'REJECTED') throw domainRule('This payment was rejected — no receipt can be issued.');
      if (payment.status === 'REVERSED') throw domainRule('This payment was reversed — its receipt has been voided.');

      const existing = this.ctx.db
        .prepare('SELECT * FROM receipts WHERE payment_id = ? AND org_id = ? AND voided_at IS NULL AND deleted_at IS NULL')
        .get(payment.id, this.ctx.orgId) as ReceiptRow | undefined;
      if (existing !== undefined) {
        throw domainRule(`A receipt (${existing.receipt_no}) was already issued for this payment. Void it first if you need to issue a new one.`);
      }

      const org = this.#organization();
      const tenancy = this.#tenancy(payment.tenancy_id);
      const tenantName = this.#tenantName(tenancy.tenant_id);
      const unitLabel = this.#unitLabel(tenancy.unit_id);
      const property = this.#property(payment.property_id);
      const deviceName = this.#deviceName();

      const signature = input.signatureId !== undefined ? this.#signatureById(input.signatureId) : this.activeSignature(payment.property_id);

      const currentBalance = this.#balance(tenancy.id);
      const previousBalance = currentBalance + payment.amount_minor;

      const periods = this.#allocationPeriods(payment.id);

      const receiptNo = this.#nextReceiptNumber();

      const snapshot: ReceiptSnapshot = {
        receiptNo,
        issuedAt: this.ctx.clock.nowIso(),
        orgName: org.name,
        landlordName: org.landlord_name,
        kraPin: org.kra_pin,
        currency: org.currency,
        propertyName: property.name,
        propertyLocation: [property.estate, property.town].filter((x) => x !== null && x !== '').join(', '),
        tenantName,
        unitLabel,
        paymentId: payment.id,
        amountMinor: payment.amount_minor,
        amountWords: shillingsInWords(payment.amount_minor),
        paidAt: payment.paid_at,
        method: payment.method,
        reference: payment.reference,
        periods,
        primaryPeriod: periods[0] ?? null,
        previousBalanceMinor: previousBalance,
        remainingBalanceMinor: currentBalance,
        signatureLabel: signature?.label ?? null,
        signatureDigest: signature?.image_digest ?? null,
        issuedBy: this.#userName(this.ctx.userId),
        deviceName,
      };

      const snapshotJson = canonicalJson(snapshot);
      const digest = sha256HexOfUtf8(snapshotJson);

      let cryptoSignature: string | null = null;
      const key = this.#ensureReceiptKey();
      if (key !== null) {
        // Signature over the UTF-8 bytes of the digest hex string (RECEIPTS.md §5).
        cryptoSignature = bytesToBase64(this.#crypto!.signEd25519(base64ToBytes(key.private_key), utf8Bytes(digest)));
      }

      const stamp = stampNew(this.ctx);
      const receipt: ReceiptRow = {
        ...stamp,
        receipt_no: receiptNo,
        payment_id: payment.id,
        tenancy_id: tenancy.id,
        property_id: payment.property_id,
        snapshot_json: snapshotJson,
        digest,
        signature_image_id: signature?.id ?? null,
        signature_digest: signature?.image_digest ?? null,
        crypto_signature: cryptoSignature,
        issued_by_user_id: this.ctx.userId,
        issued_by_device_id: this.ctx.deviceId,
        voided_at: null,
        void_reason: null,
      };
      insertRow(this.ctx.db, 'receipts', receipt);
      recordOp(this.ctx, 'receipts', receipt);

      appendAudit(this.ctx, {
        action: 'RECEIPT_ISSUED',
        entityType: 'receipt',
        entityId: receipt.id,
        summary: `Receipt ${receiptNo} issued to ${tenantName} (house ${unitLabel}) for ${formatKsh(payment.amount_minor)}.`,
        after: { ...receipt },
      });
      return { receipt, snapshot };
    }
  }

  /** Void a receipt (wrong receipt, reversal). The number is never reused. */
  voidReceipt(receiptId: string, reason: string): ReceiptRow {
    requireRole(this.ctx, ['OWNER'], 'void a receipt');
    const why = reason.trim();
    if (why === '') throw validationError('Give a reason for voiding the receipt.');

    return this.ctx.db.transaction(() => {
      const receipt = this.getReceipt(receiptId);
      if (receipt.voided_at !== null) return receipt;
      const voided = voidReceiptTx(this.ctx, receipt, why);
      return voided;
    });
  }

  /** Void + issue a fresh receipt for the same payment (corrections keep history). */
  reissueReceipt(receiptId: string, reason: string): { voided: ReceiptRow; reissued: IssueReceiptResult } {
    requireRole(this.ctx, ['OWNER'], 'reissue a receipt');
    const why = reason.trim();
    if (why === '') throw validationError('Give a reason for reissuing the receipt.');

    return this.ctx.db.transaction(() => {
      const receipt = this.getReceipt(receiptId);
      if (receipt.voided_at !== null) {
        throw domainRule('This receipt is already voided. Issue a new one instead.');
      }
      const voided = voidReceiptTx(this.ctx, receipt, `Reissued: ${why}`);
      const reissued = this.#issueReceiptTx(receipt.payment_id, {});
      return { voided, reissued };
    });
  }

  // -- reads ---------------------------------------------------------------------

  getReceipt(id: string): ReceiptRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM receipts WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as ReceiptRow | undefined;
    if (row === undefined) throw domainRule('Receipt not found.');
    return row;
  }

  getReceiptByNo(receiptNo: string): ReceiptRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM receipts WHERE org_id = ? AND receipt_no = ? AND deleted_at IS NULL')
      .get(this.ctx.orgId, receiptNo) as ReceiptRow | undefined;
    if (row === undefined) throw domainRule(`Receipt ${receiptNo} was not found.`);
    return row;
  }

  listReceipts(input: { propertyId?: string; month?: string; includeVoided?: boolean; limit?: number } = {}): ReceiptRow[] {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    const clauses = ['org_id = ?', 'deleted_at IS NULL'];
    const params: string[] = [this.ctx.orgId];
    if (input.propertyId !== undefined) {
      clauses.push('property_id = ?');
      params.push(input.propertyId);
    }
    if (input.month !== undefined) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw validationError('Use a month like 2026-09.');
      clauses.push("substr(created_at, 1, 7) = ?");
      params.push(input.month);
    }
    if (!(input.includeVoided ?? false)) {
      clauses.push('voided_at IS NULL');
    }
    return this.ctx.db
      .prepare(`SELECT * FROM receipts WHERE ${clauses.join(' AND ')} ORDER BY receipt_no DESC LIMIT ?`)
      .all(...params, String(limit)) as ReceiptRow[];
  }

  /**
   * Verify a receipt's integrity offline: recompute the digest from the stored
   * snapshot and check the Ed25519 signature (RECEIPTS.md §5). A forged or
   * tampered receipt fails here even without any network.
   */
  verifyReceiptIntegrity(receipt: ReceiptRow): ReceiptIntegrity {
    const recomputed = sha256HexOfUtf8(receipt.snapshot_json);
    const digestMatches = recomputed === receipt.digest;
    let signatureValid: boolean | null = null;
    if (receipt.crypto_signature !== null) {
      const key = this.#receiptKey();
      if (key !== null) {
        signatureValid = this.#crypto !== undefined
          ? this.#crypto.verifyEd25519(
              base64ToBytes(key.public_key),
              utf8Bytes(receipt.digest),
              base64ToBytes(receipt.crypto_signature),
            )
          : false;
      }
    }
    return { ok: digestMatches && (signatureValid === null || signatureValid), digestMatches, signatureValid };
  }

  /** Receipt numbers remaining in this device's current block (UI warning at 80%). */
  numbersRemainingInBlock(): number {
    const row = this.ctx.db
      .prepare(
        'SELECT * FROM receipt_number_blocks WHERE org_id = ? AND device_id = ? AND next_value <= block_end AND deleted_at IS NULL ORDER BY block_end DESC LIMIT 1',
      )
      .get(this.ctx.orgId, this.ctx.deviceId) as ReceiptNumberBlockRow | undefined;
    if (row === undefined) return 0;
    return row.block_end + 1 - row.next_value;
  }

  // -- internals -------------------------------------------------------------------

  #nextReceiptNumber(): string {
    let block = this.ctx.db
      .prepare(
        'SELECT * FROM receipt_number_blocks WHERE org_id = ? AND device_id = ? AND next_value <= block_end AND deleted_at IS NULL ORDER BY block_end DESC LIMIT 1',
      )
      .get(this.ctx.orgId, this.ctx.deviceId) as ReceiptNumberBlockRow | undefined;

    if (block === undefined) {
      // Lazy allocation: continue after the highest block ever granted in this org.
      // Single-device orgs start at 1; a second paired device continues from the
      // synced maximum (M5 pairing grants blocks explicitly — docs/RECEIPTS.md §2).
      const maxRow = this.ctx.db
        .prepare('SELECT COALESCE(MAX(block_end), 0) AS max_end FROM receipt_number_blocks WHERE org_id = ? AND deleted_at IS NULL')
        .get(this.ctx.orgId) as { max_end: number };
      const start = maxRow.max_end + 1;
      const stamp = stampNew(this.ctx);
      const newBlock: ReceiptNumberBlockRow = {
        ...stamp,
        device_id: this.ctx.deviceId,
        block_start: start,
        block_end: start + RECEIPT_BLOCK_SIZE - 1,
        next_value: start,
      };
      insertRow(this.ctx.db, 'receipt_number_blocks', newBlock);
      recordOp(this.ctx, 'receipt_number_blocks', newBlock);
      appendAudit(this.ctx, {
        action: 'RECEIPT_BLOCK_RESERVED',
        entityType: 'organization',
        entityId: this.ctx.orgId,
        summary: `Receipt numbers ${start}–${newBlock.block_end} reserved for this device.`,
        after: { ...newBlock },
      });
      block = newBlock;
    }

    const n = block.next_value;
    stampUpdate(this.ctx, block);
    block.next_value = n + 1;
    updateRow(this.ctx.db, 'receipt_number_blocks', block);
    recordOp(this.ctx, 'receipt_number_blocks', block);
    return `R-${String(n).padStart(6, '0')}`;
  }

  #ensureReceiptKey(): { public_key: string; private_key: string } | null {
    const existing = this.#receiptKey();
    if (existing !== null) return existing;
    if (this.#crypto === undefined) {
      // Receipts still issue without a crypto signature; digest alone remains.
      return null;
    }
    const pair = this.#crypto.generateEd25519();
    const stamp = stampNew(this.ctx);
    const key = {
      ...stamp,
      purpose: 'receipt_signing',
      public_key: bytesToBase64(pair.publicSpki),
      private_key: bytesToBase64(pair.privatePkcs8),
    };
    insertRow(this.ctx.db, 'org_keys', key);
    recordOp(this.ctx, 'org_keys', key);
    appendAudit(this.ctx, {
      action: 'ORG_KEY_GENERATED',
      entityType: 'organization',
      entityId: this.ctx.orgId,
      summary: 'Receipt signing key generated for this organization.',
    });
    return { public_key: key.public_key, private_key: key.private_key };
  }

  #receiptKey(): { public_key: string; private_key: string } | null {
    const row = this.ctx.db
      .prepare("SELECT public_key, private_key FROM org_keys WHERE org_id = ? AND purpose = 'receipt_signing' AND deleted_at IS NULL")
      .get(this.ctx.orgId) as { public_key: string; private_key: string } | undefined;
    return row ?? null;
  }

  #payment(id: string): PaymentRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM payments WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as PaymentRow | undefined;
    if (row === undefined) throw domainRule('Payment not found.');
    return row;
  }

  #tenancy(id: string): TenancyRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM tenancies WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as TenancyRow | undefined;
    if (row === undefined) throw domainRule('Tenancy not found.');
    return row;
  }

  #tenantName(id: string): string {
    const row = this.ctx.db.prepare('SELECT full_name FROM tenants WHERE id = ?').get(id) as { full_name: string } | undefined;
    return row?.full_name ?? 'Tenant';
  }

  #unitLabel(id: string): string {
    const row = this.ctx.db.prepare('SELECT label FROM units WHERE id = ?').get(id) as { label: string } | undefined;
    return row?.label ?? '';
  }

  #property(id: string): { name: string; estate: string | null; town: string | null } {
    const row = this.ctx.db
      .prepare('SELECT name, estate, town FROM properties WHERE id = ?')
      .get(id) as { name: string; estate: string | null; town: string | null } | undefined;
    return row ?? { name: '', estate: null, town: null };
  }

  #organization(): OrganizationRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM organizations WHERE org_id = ? AND deleted_at IS NULL')
      .get(this.ctx.orgId) as OrganizationRow | undefined;
    if (row === undefined) throw domainRule('Organization not found.');
    return row;
  }

  #deviceName(): string {
    const row = this.ctx.db
      .prepare('SELECT name FROM devices WHERE id = ?')
      .get(this.ctx.deviceId) as { name: string } | undefined;
    return row?.name ?? 'Kitabu device';
  }

  #userName(id: string | null): string | null {
    if (id === null) return null;
    const row = this.ctx.db.prepare('SELECT full_name FROM users WHERE id = ?').get(id) as { full_name: string } | undefined;
    return row?.full_name ?? null;
  }

  #signatureById(id: string): SignatureImageRow | null {
    const row = this.ctx.db
      .prepare('SELECT * FROM signature_images WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as SignatureImageRow | undefined;
    return row ?? null;
  }

  #balance(tenancyId: string): number {
    const row = this.ctx.db
      .prepare(
        `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0) AS balance
         FROM ledger_entries WHERE tenancy_id = ? AND deleted_at IS NULL`,
      )
      .get(tenancyId) as { balance: number };
    return row.balance;
  }

  /** Periods this payment settled (from allocations), oldest first. */
  #allocationPeriods(paymentId: string): string[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT DISTINCT le.period AS period
         FROM payment_allocations a
         JOIN ledger_entries le ON le.id = a.charge_id
         WHERE a.payment_id = ? AND a.deleted_at IS NULL AND le.period IS NOT NULL
         ORDER BY le.period ASC`,
      )
      .all(paymentId) as Array<{ period: string }>;
    return rows.map((r) => r.period);
  }
}

/**
 * Void a receipt inside the caller's transaction (shared by ReceiptService and
 * payment reversal). Only the void columns change — the immutability trigger
 * guarantees everything else is frozen. The number is never reused.
 */
export function voidReceiptTx(ctx: ServiceContext, receipt: ReceiptRow, reason: string): ReceiptRow {
  const before = { ...receipt };
  stampUpdate(ctx, receipt);
  receipt.voided_at = ctx.clock.nowIso();
  receipt.void_reason = reason;
  updateRow(ctx.db, 'receipts', receipt);
  recordOp(ctx, 'receipts', receipt);
  appendAudit(ctx, {
    action: 'RECEIPT_VOIDED',
    entityType: 'receipt',
    entityId: receipt.id,
    summary: `Receipt ${receipt.receipt_no} voided — ${reason}.`,
    before,
    after: { ...receipt },
  });
  return receipt;
}
