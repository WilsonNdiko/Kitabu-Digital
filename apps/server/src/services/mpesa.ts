/**
 * M-Pesa statement-import verification (docs/MPESA.md §2).
 *
 * THE FUNDAMENTAL RULE: Kitabu records and verifies payments — it NEVER
 * processes, initiates, or receives money. A statement import is evidence
 * against which recorded references are matched; nothing more.
 *
 * The landlord exports their M-Pesa statement (CSV) from the M-Pesa app or
 * portal and imports it here. Each incoming line is stored with an id
 * deterministic in (org, receipt_no), so importing the same statement on two
 * devices converges in sync with no duplicates. Matching then auto-verifies
 * PENDING M-Pesa payments whose reference AND amount agree with a statement
 * line; amount mismatches are flagged for human review — never auto-resolved.
 */
import { assertPaymentTransition, canVerifyPayments, type PaymentStatus } from '@kitabu/core';
import { AppError, audit, insertRowIfAbsent, nowIso, updateRow, type Ctx } from '../db/index.js';
import { contentHash } from './setup.js';
import { postPaymentToLedger } from './finance.js';

// ------------------------------------------------------------- CSV parsing --
/** Minimal RFC-4180 parser: quoted fields, embedded commas/newlines, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** "1,234.00" | "KSh 1,234" | "1234.5" → cents; null when not a number. */
function moneyToMinor(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/ksh?s?\.?/i, '').replace(/[,\s"]/g, '').trim();
  if (!cleaned || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export interface StatementLine { receiptNo: string; completedAt: string | null; details: string; paidInMinor: number }

/**
 * Understands the standard M-Pesa statement export — preamble lines, then a
 * header row ("Receipt No., Completion Time, Details, Transaction Status,
 * Paid In, Withdrawn, Balance") — plus simple hand-made sheets with at least
 * a code column and an amount column.
 */
export function parseStatement(csvText: string): StatementLine[] {
  const rows = parseCsv(csvText);
  const norm = (s: string) => s.trim().toLowerCase();

  // find the header row
  let headerIdx = -1; let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const h = rows[i]!.map(norm);
    const find = (...names: string[]) => h.findIndex((c) => names.some((n) => c.includes(n)));
    const receipt = find('receipt', 'code', 'reference', 'ref');
    const amount = find('paid in', 'amount', 'paidin');
    if (receipt >= 0 && amount >= 0) {
      headerIdx = i;
      cols = {
        receipt, amount,
        time: find('completion time', 'time', 'date'),
        details: find('details', 'description', 'narrative'),
        status: find('transaction status', 'status'),
        withdrawn: find('withdrawn'),
      };
      break;
    }
  }
  if (headerIdx < 0) {
    throw new AppError('Could not find the statement columns. Export the CSV from M-Pesa (it should have "Receipt No." and "Paid In" columns), or use columns named Code and Amount.');
  }

  const out: StatementLine[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const receiptNo = (r[cols.receipt!] ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,14}$/.test(receiptNo)) continue;              // not a transaction row
    if (cols.status! >= 0 && r[cols.status!] && !/complete/i.test(r[cols.status!]!)) continue;
    const paidIn = moneyToMinor(r[cols.amount!]);
    if (paidIn === null || paidIn <= 0) continue;                    // money IN only
    out.push({
      receiptNo,
      completedAt: cols.time! >= 0 ? (r[cols.time!] ?? '').trim() || null : null,
      details: cols.details! >= 0 ? (r[cols.details!] ?? '').trim() : '',
      paidInMinor: paidIn,
    });
  }
  return out;
}

// ---------------------------------------------------------- import & match --
export interface ImportSummary {
  parsedLines: number; newLines: number; alreadyKnown: number;
  autoVerified: number; mismatches: MatchIssue[]; stillUnmatched: number;
}
export interface MatchIssue {
  paymentId: string; tenantName: string; reference: string;
  expectedMinor: number; statementMinor: number;
}

export function importStatement(ctx: Ctx, csvText: string): ImportSummary {
  if (!canVerifyPayments(ctx.userRole)) throw new AppError('Only the owner or a manager can import statements.', 403);
  if (!csvText?.trim()) throw new AppError('That file looks empty.');
  const lines = parseStatement(csvText);
  if (!lines.length) throw new AppError('No completed incoming payments were found in that statement.');

  let newLines = 0;
  ctx.db.transaction(() => {
    for (const l of lines) {
      const id = `msl_${contentHash(`${ctx.orgId}|${l.receiptNo}`).slice(0, 26)}`;
      const inserted = insertRowIfAbsent(ctx, 'mpesa_statement_lines', {
        id, org_id: ctx.orgId, receipt_no: l.receiptNo, completed_at: l.completedAt,
        details: l.details, paid_in_minor: l.paidInMinor, imported_at: nowIso(),
      });
      if (inserted) newLines++;
    }
    audit(ctx, 'mpesa.statement_imported', 'mpesa_statement_lines', 'batch', undefined,
      { parsed: lines.length, new: newLines });
  })();

  const match = matchPendingPayments(ctx);
  return {
    parsedLines: lines.length, newLines, alreadyKnown: lines.length - newLines,
    ...match,
  };
}

/**
 * Match every PENDING/VERIFYING M-Pesa payment against known statement lines.
 * Reference + exact amount agree → VERIFIED (ledger posted, audited with
 * provider evidence). Amount differs → flagged, left for human review.
 */
export function matchPendingPayments(ctx: Ctx): { autoVerified: number; mismatches: MatchIssue[]; stillUnmatched: number } {
  const pending = ctx.db.prepare(
    `SELECT p.*, t.full_name tenant_name
       FROM payments p
       JOIN tenancies ty ON ty.id = p.tenancy_id
       JOIN tenants t ON t.id = ty.tenant_id
      WHERE p.org_id = ? AND p.method = 'MPESA' AND p.status IN ('PENDING','VERIFYING')
        AND p.reference IS NOT NULL AND p.deleted_at IS NULL`,
  ).all(ctx.orgId) as any[];

  let autoVerified = 0; const mismatches: MatchIssue[] = []; let stillUnmatched = 0;
  ctx.db.transaction(() => {
    for (const p of pending) {
      const line = ctx.db.prepare(
        'SELECT * FROM mpesa_statement_lines WHERE org_id = ? AND receipt_no = ? AND deleted_at IS NULL',
      ).get(ctx.orgId, p.reference) as any;
      if (!line) { stillUnmatched++; continue; }
      if (line.paid_in_minor !== p.amount_minor) {
        mismatches.push({
          paymentId: p.id, tenantName: p.tenant_name, reference: p.reference,
          expectedMinor: p.amount_minor, statementMinor: line.paid_in_minor,
        });
        continue; // never auto-resolve a mismatch (MPESA.md rule 4)
      }
      assertPaymentTransition(p.status as PaymentStatus, 'VERIFIED');
      updateRow(ctx, 'payments', p.id, { status: 'VERIFIED', verified_by: ctx.userId, verified_at: nowIso() });
      postPaymentToLedger(ctx, p.id, p.tenancy_id, p.amount_minor, p.payment_date);
      audit(ctx, 'payment.verified', 'payments', p.id, { status: p.status },
        { status: 'VERIFIED', provider: 'statement-import', receiptNo: line.receipt_no, statementLineId: line.id });
      autoVerified++;
    }
  })();
  return { autoVerified, mismatches, stillUnmatched };
}

/** Review queue: every waiting M-Pesa payment + what the statement says about it. */
export function verificationQueue(ctx: Ctx) {
  return ctx.db.prepare(
    `SELECT p.id, p.amount_minor, p.reference, p.payment_date, p.status,
            t.full_name tenant_name, u.label unit_label,
            l.paid_in_minor statement_minor, l.completed_at statement_time, l.details statement_details
       FROM payments p
       JOIN tenancies ty ON ty.id = p.tenancy_id
       JOIN tenants t ON t.id = ty.tenant_id
       JOIN units u ON u.id = ty.unit_id
       LEFT JOIN mpesa_statement_lines l
         ON l.org_id = p.org_id AND l.receipt_no = p.reference AND l.deleted_at IS NULL
      WHERE p.org_id = ? AND p.method = 'MPESA' AND p.status IN ('PENDING','VERIFYING')
        AND p.deleted_at IS NULL
      ORDER BY p.payment_date DESC`,
  ).all(ctx.orgId);
}

export function statementStatus(ctx: Ctx) {
  const s = ctx.db.prepare(
    'SELECT COUNT(*) lines, MAX(imported_at) last FROM mpesa_statement_lines WHERE org_id = ? AND deleted_at IS NULL',
  ).get(ctx.orgId) as any;
  return { lines: s.lines as number, lastImportAt: (s.last as string) ?? null };
}
