import { beforeEach, describe, expect, it } from 'vitest';
import { parseKshToMinor } from '@kitabu/core';
import { openDb, type Ctx, type DB } from '../src/db/index.js';
import { getCtx, runSetup } from '../src/services/setup.js';
import { createTenant } from '../src/services/portfolio.js';
import { recordPayment, tenancyBalance } from '../src/services/finance.js';
import { createUser, loginUser } from '../src/services/users.js';
import { importStatement, parseStatement, verificationQueue } from '../src/services/mpesa.js';

const K = (s: string) => parseKshToMinor(s);
const today = new Date().toISOString().slice(0, 10);

/** A realistic M-Pesa export: preamble lines, quoted details with commas, thousands separators. */
const STATEMENT = `M-PESA STATEMENT
Customer Name,WILSON NDIKO
Period,01/09/2026 - 28/09/2026

Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance
SFR8K2L9QX,2026-09-05 14:22:11,"Funds received from - 254712345678, JOHN KAMAU",Completed,"12,000.00",,"45,120.00"
TAB3XY9QL2,2026-09-06 09:10:00,"Funds received from - 254733999888, GRACE ACHIENG",Completed,"8,000.00",,"53,120.00"
QWE1RT2YU3,2026-09-07 18:45:59,"Pay Bill to KPLC",Completed,,"1,450.00","51,670.00"
ZXC9VB8NM7,2026-09-08 08:00:00,"Funds received from - 254700111222, PETER OTIENO",Failed,"5,000.00",,
`;

let db: DB; let ctx: Ctx; let tenancyA: string; let tenancyB: string;

beforeEach(() => {
  db = openDb(':memory:');
  runSetup(db, {
    ownerName: 'Wilson', orgName: 'Green View',
    propertyName: 'Green View', units: [
      { label: 'A-1', rentMinor: K('12000') }, { label: 'A-2', rentMinor: K('8000') },
    ],
  });
  ctx = getCtx(db)!;
  const units = db.prepare('SELECT id FROM units ORDER BY label').all() as any[];
  tenancyA = createTenant(ctx, { fullName: 'John Kamau', moveIn: { unitId: units[0].id, startDate: today } }).tenancyId!;
  tenancyB = createTenant(ctx, { fullName: 'Grace Achieng', moveIn: { unitId: units[1].id, startDate: today } }).tenancyId!;
});

describe('statement parsing', () => {
  it('parses the real export shape: preamble, quoted commas, money-in only, Completed only', () => {
    const lines = parseStatement(STATEMENT);
    expect(lines.map((l) => l.receiptNo)).toEqual(['SFR8K2L9QX', 'TAB3XY9QL2']); // no paybill-out, no Failed
    expect(lines[0]!.paidInMinor).toBe(K('12000'));
    expect(lines[0]!.details).toContain('JOHN KAMAU');
  });

  it('accepts simple hand-made sheets (Code + Amount columns)', () => {
    const lines = parseStatement('Code,Amount\nSFR8K2L9QX,12000\nTAB3XY9QL2,"8,000"');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.paidInMinor).toBe(K('8000'));
  });

  it('rejects files with no recognizable columns', () => {
    expect(() => importStatement(ctx, 'hello\nworld')).toThrow(/columns/);
  });
});

describe('import & auto-verification (recording only — never processing)', () => {
  it('auto-verifies a PENDING payment whose reference and amount match; posts the ledger', () => {
    // a caretaker recorded John's M-Pesa payment → PENDING
    const jane = createUser(ctx, { fullName: 'Jane', role: 'CARETAKER' });
    loginUser(db, { userId: jane.id });
    const p = recordPayment(getCtx(db)!, { tenancyId: tenancyA, amountMinor: K('12000'), method: 'MPESA', reference: 'SFR8K2L9QX' });
    expect(p.status).toBe('PENDING');

    loginUser(db, { userId: ctx.userId });
    const owner = getCtx(db)!;
    const sum = importStatement(owner, STATEMENT);
    expect(sum.newLines).toBe(2);
    expect(sum.autoVerified).toBe(1);
    expect(sum.mismatches).toHaveLength(0);

    const after = db.prepare('SELECT status, verified_by FROM payments WHERE id = ?').get(p.id) as any;
    expect(after.status).toBe('VERIFIED');
    expect(after.verified_by).toBe(ctx.userId); // the importer verified, with statement evidence
    expect(tenancyBalance(owner, tenancyA)).toBe(0);
    // audit trail names the provider
    const a = db.prepare("SELECT after_json FROM audit_log WHERE action='payment.verified'").get() as any;
    expect(JSON.parse(a.after_json).provider).toBe('statement-import');
  });

  it('flags amount mismatches for review — never auto-resolves them', () => {
    const p = recordPayment(ctx, { tenancyId: tenancyB, amountMinor: K('8500'), method: 'MPESA', reference: 'TAB3XY9QL2' });
    const sum = importStatement(ctx, STATEMENT);
    expect(sum.autoVerified).toBe(0);
    expect(sum.mismatches).toEqual([expect.objectContaining({
      paymentId: p.id, reference: 'TAB3XY9QL2',
      expectedMinor: K('8500'), statementMinor: K('8000'),
    })]);
    expect((db.prepare('SELECT status FROM payments WHERE id = ?').get(p.id) as any).status).toBe('PENDING');
    // the queue shows the discrepancy side by side
    const q = verificationQueue(ctx) as any[];
    expect(q[0].statement_minor).toBe(K('8000'));
  });

  it('references missing from the statement stay pending', () => {
    recordPayment(ctx, { tenancyId: tenancyA, amountMinor: K('12000'), method: 'MPESA', reference: 'NOTONSTMT1' });
    const sum = importStatement(ctx, STATEMENT);
    expect(sum.autoVerified).toBe(0);
    expect(sum.stillUnmatched).toBe(1);
  });

  it('re-importing the same statement is idempotent (no double ledger post)', () => {
    recordPayment(ctx, { tenancyId: tenancyA, amountMinor: K('12000'), method: 'MPESA', reference: 'SFR8K2L9QX' });
    importStatement(ctx, STATEMENT);
    const sum2 = importStatement(ctx, STATEMENT);
    expect(sum2.newLines).toBe(0);
    expect(sum2.alreadyKnown).toBe(2);
    expect(sum2.autoVerified).toBe(0); // already VERIFIED, not re-processed
    const posts = db.prepare("SELECT COUNT(*) c FROM ledger_entries WHERE entry_type='PAYMENT'").get() as any;
    expect(posts.c).toBe(1);
    expect(tenancyBalance(ctx, tenancyA)).toBe(0);
  });

  it('caretakers cannot import statements', () => {
    const jane = createUser(ctx, { fullName: 'Jane', role: 'CARETAKER' });
    loginUser(db, { userId: jane.id });
    expect(() => importStatement(getCtx(db)!, STATEMENT)).toThrow(/owner or a manager/);
  });
});
