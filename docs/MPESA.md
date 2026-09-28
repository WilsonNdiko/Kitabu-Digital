# Kitabu Digital — M-Pesa Architecture

## 0. The fundamental rule

> **Kitabu records and verifies payments. It never processes, initiates, or receives money.**

Tenants pay the landlord exactly as they do today: M-Pesa send-money to the landlord's number, paybill/till, cash in hand, or bank deposit. Kitabu's job is the *book-keeping*: record the payment, verify it happened, post it to the ledger, and issue the receipt. There is no STK push, no wallet, no settlement, and no movement of funds through Kitabu — by design, permanently. This dramatically reduces regulatory, security, and trust surface, and matches how landlords actually operate.

## 1. Recording workflow (works fully offline)

```
Tenant pays landlord via M-Pesa (outside Kitabu)
        ↓
Manager/caretaker records payment in Kitabu:
   tenant → amount → method=MPESA → reference (e.g. SFR8K2L9QX) → payer
        ↓
Duplicate reference check (UNIQUE(org, method, reference)) — offline, local DB
Format sanity check (10-char alphanumeric M-Pesa shape) — offline
        ↓
Status: PENDING VERIFICATION          ← a typed reference is NEVER auto-trusted
        ↓
Verification (see §2)                 ← may happen days later, when online/at the laptop
        ↓
VERIFIED → ledger PAYMENT entry posted → receipt can be issued
   or REJECTED (reason recorded, tenant balance unchanged)
```

Cash recorded by the owner/manager is VERIFIED at entry (they held the money). Cash recorded by a caretaker is PENDING until the manager/owner approves — mirroring how landlords already reconcile with caretakers.

## 2. Verification — provider abstraction

```ts
interface PaymentVerificationProvider {
  id: string;                                  // 'manual' | 'statement-import' | 'daraja-query' | 'sandbox'
  canVerify(payment: PaymentDraft): boolean;
  verify(payment: PaymentDraft): Promise<VerificationResult>;
}
// VerificationResult: CONFIRMED {matchedTx} | NOT_FOUND | MISMATCH {field, expected, actual} | UNAVAILABLE
```

| Provider | How it verifies | Requires |
|---|---|---|
| **manual** (v1 default) | Owner/manager compares against their own M-Pesa SMS/statement and confirms in-app. The *human* is the verifier; Kitabu records who verified, when, on which device. | Nothing — fully offline |
| **statement-import** | Landlord exports their M-Pesa statement (CSV/PDF) and imports it; Kitabu auto-matches references/amounts/dates to PENDING payments and flags mismatches. | Occasional connectivity to fetch statement |
| **daraja-query** | For landlords with their own paybill/till: Safaricom Daraja *Transaction Status* API confirms a reference against their shortcode. Query-only — never C2B initiation. | Internet + landlord's Daraja credentials |
| **sandbox** | Daraja sandbox for automated tests. Clearly labelled; **never wired into production builds; verification is never faked in development against real data.** |

Offline behaviour: PENDING payments queue for verification; when a provider becomes available, matching runs and statuses update — the recording flow never blocks on connectivity.

## 3. Rules

1. A syntactically valid reference is *evidence*, not *proof* — always lands as PENDING.
2. Duplicate `(org, method, reference)` rejected at the database level with a friendly message naming the earlier payment.
3. Verification outcome, provider, actor, and timestamp are stored on the payment and in the audit log.
4. Mismatches (amount differs from statement, etc.) surface in a review queue; nothing auto-mutates a verified record.
5. Receipts only for VERIFIED payments.
