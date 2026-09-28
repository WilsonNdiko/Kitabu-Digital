/**
 * Payment state machine (docs/DATABASE.md §4). Kitabu RECORDS payments made
 * outside the system — it never processes money. A typed M-Pesa reference is
 * evidence, not proof: it always enters as PENDING (docs/MPESA.md).
 */

export type PaymentMethod = 'MPESA' | 'CASH' | 'BANK' | 'OTHER';

export type PaymentStatus = 'PENDING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'REVERSED';

export type Role = 'OWNER' | 'MANAGER' | 'CARETAKER';

const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['VERIFYING', 'VERIFIED', 'REJECTED'],
  VERIFYING: ['VERIFIED', 'REJECTED', 'PENDING'],
  VERIFIED: ['REVERSED'],
  REJECTED: [],
  REVERSED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`A ${friendlyStatus(from)} payment cannot become ${friendlyStatus(to)}.`);
  }
}

/**
 * Initial status when a payment is recorded:
 * - Cash held by the owner/manager themselves → VERIFIED immediately.
 * - Everything else (M-Pesa/bank references, anything a caretaker records)
 *   → PENDING until a manager/owner verifies. Never auto-trust a reference.
 */
export function initialPaymentStatus(method: PaymentMethod, recordedByRole: Role): PaymentStatus {
  if (method === 'CASH' && (recordedByRole === 'OWNER' || recordedByRole === 'MANAGER')) {
    return 'VERIFIED';
  }
  return 'PENDING';
}

/** Roles allowed to verify / reject / reverse payments. */
export function canVerifyPayments(role: Role): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

/** Shape check for M-Pesa receipt codes (e.g. SFR8K2L9QX) — sanity only. */
export function looksLikeMpesaRef(ref: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(ref.trim());
}

export function friendlyStatus(s: PaymentStatus): string {
  switch (s) {
    case 'PENDING': return 'pending verification';
    case 'VERIFYING': return 'being verified';
    case 'VERIFIED': return 'verified';
    case 'REJECTED': return 'rejected';
    case 'REVERSED': return 'reversed';
  }
}
