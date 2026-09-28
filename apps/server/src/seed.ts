/**
 * Optional sample data — the "Green View Apartments" scenario from the brief
 * (§64), so a new user can explore Kitabu before entering real records.
 */
import { parseKshToMinor } from '@kitabu/core';
import { AppError, getSetting, type DB } from './db/index.js';
import { getCtx, runSetup } from './services/setup.js';
import { createTenant } from './services/portfolio.js';
import { recordPayment, verifyPayment, issueReceipt } from './services/finance.js';
import { createExpense, createMaintenance } from './services/operations.js';

const K = (s: string) => parseKshToMinor(s);
const monthsAgo = (n: number, day = 1) => {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - n); d.setDate(day);
  return d.toISOString().slice(0, 10);
};

export function seedDemo(db: DB) {
  if (getSetting(db, 'org_id')) throw new AppError('This device is already set up.');

  runSetup(db, {
    ownerName: 'Wilson Ndiko',
    orgName: 'Green View Properties',
    propertyName: 'Green View Apartments',
    location: 'Kasarani, Nairobi',
    units: [
      ...Array.from({ length: 6 }, (_, i) => ({ label: `A-${i + 1}`, rentMinor: K('12000') })),
      ...Array.from({ length: 6 }, (_, i) => ({ label: `B-${i + 1}`, rentMinor: K('8500') })),
    ],
  });
  const ctx = getCtx(db)!;

  const units = db.prepare('SELECT id, label, monthly_rent_minor FROM units ORDER BY label').all() as any[];
  const unit = (label: string) => units.find((u) => u.label === label)!;

  const tenants: { name: string; phone: string; unit: string; since: number }[] = [
    { name: 'John Kamau', phone: '0712 345 678', unit: 'A-1', since: 3 },
    { name: 'Mary Wanjiku', phone: '0723 456 789', unit: 'A-2', since: 3 },
    { name: 'Peter Otieno', phone: '0734 567 890', unit: 'A-3', since: 2 },
    { name: 'Grace Achieng', phone: '0745 678 901', unit: 'B-1', since: 2 },
    { name: 'Samuel Mwangi', phone: '0756 789 012', unit: 'B-2', since: 1 },
    { name: 'Faith Njeri', phone: '0110 234 567', unit: 'B-3', since: 0 },
  ];
  const tcyByName: Record<string, string> = {};
  for (const t of tenants) {
    const res = createTenant(ctx, {
      fullName: t.name, phone: t.phone,
      moveIn: { unitId: unit(t.unit).id, startDate: monthsAgo(t.since, 1) },
    });
    tcyByName[t.name] = res.tenancyId!;
  }

  // Payments: full months for older tenants, one partial, one pending M-Pesa
  const pay = (name: string, amount: string, method: 'CASH' | 'MPESA', date: string, ref?: string) =>
    recordPayment(ctx, { tenancyId: tcyByName[name]!, amountMinor: K(amount), method, reference: ref, paymentDate: date });

  // history (past months, settled)
  for (const [name, amt] of [['John Kamau', '12000'], ['Mary Wanjiku', '12000']] as const) {
    for (const m of [3, 2, 1]) {
      const p = pay(name, amt, 'MPESA', monthsAgo(m, 4), `S${name.slice(0, 2).toUpperCase()}${m}${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 10));
      verifyPayment(ctx, p.id); issueReceipt(ctx, p.id);
    }
  }
  for (const m of [2, 1]) {
    const p1 = pay('Peter Otieno', '12000', 'CASH', monthsAgo(m, 6));
    if (p1.status !== 'VERIFIED') { verifyPayment(ctx, p1.id); }
    issueReceipt(ctx, p1.id);
    const p2 = pay('Grace Achieng', '8500', 'CASH', monthsAgo(m, 7));
    issueReceipt(ctx, p2.id);
  }

  // this month: John paid in full via M-Pesa (verified + receipt)
  const j = pay('John Kamau', '12000', 'MPESA', monthsAgo(0, 3), 'SFR8K2L9QX');
  verifyPayment(ctx, j.id); issueReceipt(ctx, j.id);
  // Mary paid partially (8,000 of 12,000)
  const m1 = pay('Mary Wanjiku', '8000', 'CASH', monthsAgo(0, 5));
  issueReceipt(ctx, m1.id);
  // Samuel's M-Pesa reference recorded, still pending verification
  pay('Samuel Mwangi', '8500', 'MPESA', monthsAgo(0, 6), 'TAB3XY9QL2');
  // Peter and Grace haven't paid this month; Faith just moved in.

  // Expense + maintenance
  const prop = db.prepare('SELECT id FROM properties LIMIT 1').get() as any;
  createExpense(ctx, { propertyId: prop.id, category: 'Plumbing', amountMinor: K('3500'), description: 'Blocked drain, Block B', expenseDate: monthsAgo(0, 8) });
  createExpense(ctx, { propertyId: prop.id, category: 'Garbage', amountMinor: K('2000'), description: 'Monthly garbage collection', expenseDate: monthsAgo(0, 2) });
  createMaintenance(ctx, { propertyId: prop.id, unitId: unit('A-3').id, title: 'Leaking kitchen tap', priority: 'MEDIUM' });
  createMaintenance(ctx, { propertyId: prop.id, unitId: unit('B-2').id, title: 'Broken window latch', priority: 'LOW' });

  return { ok: true };
}
