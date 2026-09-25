/**
 * Demo seed — a believable Green View portfolio so the screens have life on
 * first run (dev/demo only; `KITABU_SEED=0` disables it).
 *
 * Story: 4 houses — one tenant fully paid (2 receipts), one partial this month
 * with an M-Pesa code still waiting for verification (recorded by the caretaker),
 * one in arrears, one new tenant who paid this month + next month in advance.
 */

import type { Kitabu } from '../../../packages/core/src/kitabu.ts';

function monthOffset(monthsBack: number): string {
  const base = new Date();
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() - monthsBack);
  return base.toISOString().slice(0, 7);
}

export function seedDemoData(kitabu: Kitabu): void {
  const thisMonth = monthOffset(0);
  const prevMonth = monthOffset(1);

  const result = kitabu.bootstrap({
    organizationName: 'Wilson Properties',
    landlordName: 'Wilson Ndiko',
    kraPin: 'A051234567X',
    phone: '0722123456',
    deviceName: "Wilson's Laptop",
    platform: 'WINDOWS',
    unitTerm: 'House',
  });
  const owner = result.ctx.userId;
  kitabu.setActingUser(owner);

  const s = kitabu.services;
  const jane = s.organization.addUser({ fullName: 'Jane Njeri', role: 'CARETAKER', phone: '0733111222' });

  const gv = s.property.createProperty({ name: 'Green View Apartments', town: 'Nairobi', estate: 'Kasarani' });
  const a11 = s.property.addUnit({ propertyId: gv.id, label: 'A-11' });
  const a12 = s.property.addUnit({ propertyId: gv.id, label: 'A-12' });
  const b04 = s.property.addUnit({ propertyId: gv.id, label: 'B-04' });
  const b05 = s.property.addUnit({ propertyId: gv.id, label: 'B-05' });

  const john = s.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678', idNumber: '31234567' });
  const mary = s.tenant.registerTenant({ fullName: 'Mary Wanjiku', phone: '0723456789' });
  const peter = s.tenant.registerTenant({ fullName: 'Peter Otieno', phone: '0734567890' });
  const grace = s.tenant.registerTenant({ fullName: 'Grace Njeri', phone: '0745678901' });

  const tJohn = s.tenancy.startTenancy({
    tenantId: john.id, unitId: a11.id, rentMinor: 1_200_000, depositMinor: 2_400_000,
    startDate: `${prevMonth}-01`,
  });
  const tMary = s.tenancy.startTenancy({
    tenantId: mary.id, unitId: a12.id, rentMinor: 1_200_000, depositMinor: 2_400_000,
    startDate: `${prevMonth}-01`,
  });
  const tPeter = s.tenancy.startTenancy({
    tenantId: peter.id, unitId: b04.id, rentMinor: 1_000_000, depositMinor: 2_000_000,
    startDate: `${prevMonth}-01`,
  });
  const tGrace = s.tenancy.startTenancy({
    tenantId: grace.id, unitId: b05.id, rentMinor: 1_200_000, depositMinor: 2_400_000,
    startDate: `${thisMonth}-01`,
  });

  s.ledger.generateMonthlyCharges(prevMonth);
  s.ledger.generateMonthlyCharges(thisMonth);

  // John: model tenant — both months paid by M-Pesa, verified, receipted.
  const johnPrev = s.payment.recordPayment({
    tenancyId: tJohn.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: `${prevMonth}-06`, reference: 'SJD4K7P2QM',
  });
  s.payment.verifyPayment(johnPrev.id, 'Code matched the M-Pesa message');
  s.receipt.issueReceipt(johnPrev.id);
  const johnThis = s.payment.recordPayment({
    tenancyId: tJohn.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: `${thisMonth}-06`, reference: 'T8N2QX9ZL4',
  });
  s.payment.verifyPayment(johnThis.id, 'Code matched the M-Pesa message');
  s.receipt.issueReceipt(johnThis.id);

  // Mary: last month cash (auto-verified, receipted); this month partial — the
  // caretaker typed the code, so it waits in the verification queue.
  const maryPrev = s.payment.recordPayment({
    tenancyId: tMary.id, amountMinor: 1_200_000, method: 'CASH', paidAt: `${prevMonth}-06`,
  });
  s.receipt.issueReceipt(maryPrev.id);
  kitabu.setActingUser(jane.id);
  s.payment.recordPayment({
    tenancyId: tMary.id, amountMinor: 600_000, method: 'MPESA', paidAt: `${thisMonth}-03`, reference: 'QGH7XJ2M9L',
  });
  kitabu.setActingUser(owner);

  // Grace: new this month, paid September + October in advance (cash, receipted).
  const graceThis = s.payment.recordPayment({
    tenancyId: tGrace.id, amountMinor: 2_400_000, method: 'CASH', paidAt: `${thisMonth}-02`,
  });
  s.receipt.issueReceipt(graceThis.id);

  // Peter: nothing recorded — he is the arrears case (two months owing).
  void tPeter;
}
