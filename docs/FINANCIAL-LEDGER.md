# Financial Ledger Design

> The financial heart of Kitabu. Implementation lands in Milestone 2
> (`packages/core/src/services/ledger*`), fully test-covered. This document is the contract.

## 1. Why a ledger (and not `rent - lastPayment`)

Kenyan landlords need real answers to hard questions: partial payments, arrears carried
across months, advance rent, rent changes mid-year, reversals of errors, disputed
statements. `balance = monthlyRent - latestPayment` cannot answer any of these and
silently corrupts history. Kitabu models money the way a rent book actually works: an
**append-only journal of signed entries** per tenancy.

```
Balance(tenancy) = Σ DEBIT entries − Σ CREDIT entries
                   (charges, penalties)   (payments, discounts, reversals-of-debits)
```

- **Positive balance = arrears.** **Negative balance = advance/credit** (shown as
  "Advance KSh X", never as a negative debt).
- Every entry is immutable. Corrections are *new* entries (`REVERSAL` pointing at the
  original). Nothing is ever edited or deleted in place.

## 2. Entry types

| Type | Direction | Meaning | Example |
|---|---|---|---|
| `CHARGE` | DEBIT | What the tenant owes | Rent for 2026-09; water bill; late fee |
| `PAYMENT_CREDIT` | CREDIT | A verified payment settling debt | M-Pesa 12,000 on 3 Sep |
| `ADJUSTMENT` | DEBIT or CREDIT | Correction that is not a reversal of a specific entry | KSh 500 discount for repairs; KSh 1,000 penalty |
| `REVERSAL` | opposite of target | Cancels a specific prior entry (kept in the sum so statements show both) | Cash payment made in error reversed |

Rules:
- `amount_minor > 0` always; direction carries the sign. No zero or negative rows.
- A `REVERSAL` **must** reference its target (`reversal_of`). A reversed payment also
  moves the `payments` row to `REVERSED` and voids its receipt (see RECEIPTS.md).
- Charges carry `period` (`YYYY-MM`) so "this month's rent" is explicit and idempotent
  (unique per tenancy + period + kind for generated charges).

## 3. Rent charges — materialized, effective-dated, idempotent

Monthly rent is **generated as rows** (not computed on the fly), by
`generateMonthlyCharges(month, {propertyId?})`:

1. For each `ACTIVE` tenancy: due date = `expected_payment_day` of the month.
2. Rate = the `rent_rates` row with the latest `effective_from <= due date`
   (rent history is never rewritten; a rate change on 15 Sep applies from October's
   due date onward if October's due date ≥ the effective date).
3. Skip if a `CHARGE` of kind `RENT` for (tenancy, period) already exists —
   **idempotent**: running twice, or on two devices, creates one charge. The unique
   key (tenancy, period, kind, source=AUTO_GENERATED) makes duplicates impossible at
   the DB level.
4. Charges post as `source = AUTO_GENERATED`; utilities/penalties are `MANUAL`.

Trigger points: app opened in a new rental month (auto, org timezone), explicit
"Generate this month's rent" action, and post-sync reconciliation (a device that was
offline applies charges generated elsewhere; the unique key dedupes).

## 4. Payments — recording, verification, posting

A payment is two linked records: a **`payments` row** (rich metadata + state machine)
and, once verified, a **`PAYMENT_CREDIT` ledger entry** (+ allocations).

### 4.1 State machine

```
                 ┌────────────┐   verify ok    ┌──────────┐
 PENDING ───────►│ VERIFYING  │───────────────►│ VERIFIED │──► REVERSED (owner-only,
                 │            │  verify failed │          │    with reason + reversal entry)
                 └─────┬──────┘   ┌───────────►└──────────┘
                       │          │
                       ▼          ▼
                   REJECTED   (back to PENDING on transient failure / retry)
```

- `PENDING` — recorded, not yet trusted (e.g., caretaker typed an M-Pesa code offline).
- `VERIFYING` — a verification attempt is in flight (online device or cloud webhook).
- `VERIFIED` — trusted: confirmed by M-Pesa provider response, or counted cash by a
  user with `finance.record_cash_verified` permission (owner/manager per settings).
  **Only now** is the `PAYMENT_CREDIT` posted and a receipt issuable.
- `REJECTED` — verification failed (wrong code, amount mismatch beyond tolerance,
  not found). Stays visible with reason; posts nothing; can be re-submitted as a new
  payment record.
- `REVERSED` — was verified, then undone (posted by an opposite `REVERSAL` entry,
  original receipt voided). Terminal.

Enforcement: transitions are validated in the domain layer **and** guarded by SQLite
triggers (verified/reversed rows immutable except whitelisted columns). The UI cannot
arbitrarily set states — only specific service calls cause specific transitions.

### 4.2 Duplicate reference protection

- `UNIQUE(org_id, method, reference) WHERE reference IS NOT NULL` — two devices can
  never both record M-Pesa code `QGH7XJ2M9L` for the same organization. The second
  insert fails at the DB level; the sync apply path converts this into a flagged
  `sync_conflicts` entry (owner review) instead of dropping data (see SYNC.md §7).
- Cash payments have no reference → unaffected.

### 4.3 Allocation (waterfall)

When a payment is verified, `allocatePayment(paymentId)` settles **oldest outstanding
charges first** (order: `entry_date`, then `id`), writing `payment_allocations` rows.
Remainder beyond all charges = advance (negative balance). Rent change, deposit
refunds and statement views all read from entries + allocations — one source of truth.
Manual re-allocation (rare) = reverse allocations + re-allocate, audited.

## 5. Worked examples (test fixtures in M2)

**Partial payment with carried arrears.** Rent 12,000/month, tenant pays 8,000 in Sep:
Aug charge 12,000 (D) + Sep charge 12,000 (D) + payment 8,000 (C) → balance 16,000;
Sep month status = PARTIAL; arrears aging shows 4,000 (Aug) + 12,000 (Sep).

**Advance rent.** New tenant pays 24,000 on move-in (rent 12,000, deposit tracked
separately): Sep charge 12,000 (D) + Oct charge 12,000 (D) + payment 24,000 (C)
→ balance 0; a further 12,000 payment → balance −12,000 → displayed "Advance KSh 12,000".

**Rent change.** Rent 12,000 → 14,000 effective 1 Oct: `rent_rates` gains a row;
Sep charges stay 12,000 forever; Oct generation reads 14,000. Tenant statement shows
both. No edits, no history rewrite.

**Error correction.** Cash 10,000 recorded and receipted; actually only 8,000 was
taken: owner reverses the payment (reason: "over-recorded by 2,000", audited) →
original entries remain, `REVERSAL` credit cancels them, receipt voided, new 8,000
payment recorded → new receipt. Statement shows every step. Who/when/why preserved.

**Duplicate M-Pesa code.** Caretaker A (offline) and Landlord both record code `QAB12...`
for 12,000. After sync, one payment is VERIFIED; the other is flagged as
duplicate-reference conflict for the owner. Never two verified payments for one
M-Pesa transaction. Never silent deletion.

## 6. Arrears & reporting queries (definitions, single source)

- **Tenancy balance**: Σ debits − Σ credits (all entries; reversals net out).
- **Month status** (tenancy × month): compare month's RENT charge vs allocations into it:
  0 → `UNPAID`; partial → `PARTIAL`; full → `PAID` (no charge generated yet → `—`).
- **Property arrears**: Σ positive tenancy balances for the property.
- **Collection rate**: Σ verified payments in period ÷ Σ rent charges due in period.
- **Deposit**: held on the tenancy row (not in the rent balance); statement shows it as
  a separate "refundable deposit" line — deposits are the tenant's money, not income.

## 7. Invariants (enforced by schema, services, and tests)

1. `SUM` over immutable entries always equals the displayed balance — no cached balance
   columns without a recompute test (v1 computes on read; property dashboards use
   indexed aggregation queries).
2. No `UPDATE`/`DELETE` on `ledger_entries` (trigger-enforced).
3. Verified/reversed payments immutable except whitelisted state columns (trigger).
4. Issued receipts immutable (see RECEIPTS.md).
5. One active tenancy per unit (partial unique index) — enforced even under sync races.
6. Payments post credits only on `VERIFIED`; `REJECTED`/`PENDING` never touch balances.
7. Rent changes never modify existing charges or rates (append-only `rent_rates`).
8. All money integer minor units; parse/display via `Money` value object only.
9. Every financial mutation writes audit + op-log in the same transaction.
10. Every rule above has a dedicated automated test (M2 suite).
