import { beforeEach, describe, expect, it } from 'vitest';
import { parseKshToMinor } from '@kitabu/core';
import { openDb, type Ctx, type DB } from '../src/db/index.js';
import { getCtx, runSetup } from '../src/services/setup.js';
import { createTenant } from '../src/services/portfolio.js';
import { recordPayment } from '../src/services/finance.js';
import { createExpense } from '../src/services/operations.js';
import { createUser, loginUser } from '../src/services/users.js';
import { askAssistant, parsePeriod } from '../src/services/assistant.js';

const K = (s: string) => parseKshToMinor(s);
const today = new Date().toISOString().slice(0, 10);
const thisPeriod = today.slice(0, 7);

let db: DB; let ctx: Ctx;

beforeEach(() => {
  db = openDb(':memory:');
  runSetup(db, {
    ownerName: 'Wilson', orgName: 'Green View',
    propertyName: 'Green View', units: [
      { label: 'A-1', rentMinor: K('12000') },
      { label: 'A-2', rentMinor: K('8000') },
      { label: 'A-3', rentMinor: K('10000') },   // stays vacant
    ],
  });
  ctx = getCtx(db)!;
  const units = db.prepare('SELECT id, label FROM units ORDER BY label').all() as any[];
  createTenant(ctx, { fullName: 'John Kamau', moveIn: { unitId: units[0].id, startDate: today } });
  const grace = createTenant(ctx, { fullName: 'Grace Achieng', moveIn: { unitId: units[1].id, startDate: today } });
  // Grace paid in full (owner cash = verified immediately)
  recordPayment(ctx, { tenancyId: grace.tenancyId!, amountMinor: K('8000'), method: 'CASH' });
});

describe('period parsing', () => {
  it('understands this month, last month, and named months', () => {
    expect(parsePeriod('collections', '2026-09-29')).toBe('2026-09');
    expect(parsePeriod('last month', '2026-09-29')).toBe('2026-08');
    expect(parsePeriod('mwezi uliopita', '2026-01-15')).toBe('2025-12');
    expect(parsePeriod('what did I collect in January', '2026-09-29')).toBe('2026-01');
    expect(parsePeriod('march 2025 collections', '2026-09-29')).toBe('2025-03');
  });
});

describe('offline command parser → deterministic tools', () => {
  it('"Who has not paid?" lists exactly the tenants in arrears with real figures', () => {
    const r = askAssistant(ctx, 'Who has not paid this month?');
    expect(r.tool).toBe('get_arrears');
    expect(r.answer).toContain('John Kamau');
    expect(r.answer).toContain('12,000');
    expect(r.answer).not.toContain('Grace');       // she paid
  });

  it('understands Swahili: "Nani hajalipa?"', () => {
    const r = askAssistant(ctx, 'Nani hajalipa?');
    expect(r.tool).toBe('get_arrears');
    expect(r.answer).toContain('John Kamau');
  });

  it('collection totals come from the report, not invented', () => {
    const r = askAssistant(ctx, 'How much did I collect this month?');
    expect(r.tool).toBe('get_collection');
    expect(r.answer).toContain('8,000');            // collected
    expect(r.answer).toContain('20,000');           // expected (12k + 8k)
  });

  it('vacant houses', () => {
    const r = askAssistant(ctx, 'Which houses are vacant?');
    expect(r.tool).toBe('get_vacant_units');
    expect(r.answer).toContain('1 of 3');
  });

  it('expenses for a month', () => {
    createExpense(ctx, {
      propertyId: (db.prepare('SELECT id FROM properties').get() as any).id,
      category: 'WATER', amountMinor: K('2500'), expenseDate: today, description: 'Water bill',
    });
    const r = askAssistant(ctx, 'What did I spend this month?');
    expect(r.tool).toBe('get_expense_summary');
    expect(r.answer).toContain('2,500');
    expect(r.answer).toContain('WATER');
  });

  it('tenant question by name → balance + last payment from the ledger', () => {
    const r = askAssistant(ctx, 'How is Grace doing?');
    expect(r.tool).toBe('get_tenant_statement');
    expect(r.answer).toContain('Grace Achieng');
    expect(r.answer).toContain('fully paid up');
    const j = askAssistant(ctx, 'kamau balance');
    expect(j.answer).toContain('owes KSh 12,000');
  });

  it('pending M-Pesa verifications', () => {
    const john = db.prepare("SELECT t.id FROM tenancies t JOIN tenants tn ON tn.id=t.tenant_id WHERE tn.full_name='John Kamau'").get() as any;
    recordPayment(ctx, { tenancyId: john.id, amountMinor: K('12000'), method: 'MPESA', reference: 'SFR8K2L9QX' });
    const r = askAssistant(ctx, 'Any payments waiting for verification?');
    expect(r.tool).toBe('get_pending_verifications');
    expect(r.answer).toContain('SFR8K2L9QX');
  });

  it('caretakers are refused org-wide financial totals — same RBAC as the UI', () => {
    const jane = createUser(ctx, { fullName: 'Jane', role: 'CARETAKER' });
    loginUser(db, { userId: jane.id });
    const janeCtx = getCtx(db)!;
    expect(askAssistant(janeCtx, 'how much did I collect?').answer).toContain('owner and managers');
    expect(askAssistant(janeCtx, 'expenses this month').answer).toContain('owner and managers');
    // but operational questions still work
    expect(askAssistant(janeCtx, 'who has not paid?').tool).toBe('get_arrears');
  });

  it('unknown questions get a friendly help answer, never a made-up figure', () => {
    const r = askAssistant(ctx, 'what is the meaning of life?');
    expect(r.tool).toBe('unknown');
    expect(r.answer).toContain('did not understand');
    expect(r.answer).not.toMatch(/KSh\s*\d/);
  });

  it('summary gives the dashboard numbers', () => {
    const r = askAssistant(ctx, 'summary');
    expect(r.tool).toBe('get_dashboard');
    expect(r.answer).toContain('2/3 houses occupied');
    expect((r.data as any).period).toBe(thisPeriod);
  });
});
