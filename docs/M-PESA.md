# M-Pesa Integration Architecture

> Phase 6. **Rule: verification is only ever the result of a real provider response.**
> A code a user typed is *evidence*, never *proof* (brief §15). Production code paths
> contain no faked verification, no "test mode" bypass, no synthetic confirmations.

## 1. Business reality we design for

- Tenants pay the **landlord's own** Paybill/Till/Pochi number from their own phones.
  Kitabu never holds, moves, or collects funds — it records and verifies.
- Verification must work when the recording device is offline (caretaker types the
  code in the field; verification happens later, on any device with connectivity, or
  via the cloud webhook).

## 2. Provider abstraction

```ts
interface MpesaProviderPort {
  // Daraja Transaction Status API / C2B query
  verifyByCode(ref: string): Promise<MpesaTransaction | NotFound | TransientError>;
  // STK push (ask tenant's phone to pay the landlord's till)
  requestPayment(req): Promise<{ merchantRequestId; checkoutRequestId }>;
  health(): Promise<boolean>;
}
```

Implementations:
- `DarajaSandboxProvider` — Safaricom sandbox (OAuth, sandbox keys via environment).
- `DarajaProductionProvider` — same code paths, production credentials, passkey +
  certificate handling; short-lived token caching.
- `NullProvider` — the default offline state: leaves payments `PENDING` (never
  verifies, never rejects — just unavailable).
- `FixtureProvider` — **tests only**, marked and asserted against accidental
  production registration (a guard test fails if a fixture provider is ever
  constructed outside the test harness).

## 3. Verification workflow

```
OFFLINE (caretaker phone)                      ONLINE (any authorized device / cloud)
─────────────────────────                      ─────────────────────────────────────
Tenant pays via M-Pesa                         Daraja C2B Confirmation webhook
Caretaker records payment + code   ──sync──►   mpesa_transactions inbox row
status = PENDING (receipt withheld)            (org resolved via shortcode→org map)
                                               │
                                               ├─ auto-match: code already recorded?
                                               │    → payment PENDING → VERIFIED
                                               │      (receipt becomes issuable)
                                               └─ unmatched: suggested matches by
                                                  (tenant phone + amount ± tolerance
                                                   + time window); owner confirms.
                                               Manual verify by code (owner/manager):
                                                 verifyByCode(ref) → status API result
                                                 → VERIFIED / REJECTED(reason)
```

Rules:
- `verifyByCode` results bind: `transID`, amount, msisdn (masked), time. Amount
  mismatch beyond tolerance (default ±KSh 5, configurable) → `REJECTED` with reason
  "amount mismatch" or flagged for owner decision per settings.
- Duplicate codes are impossible per org (unique index; SYNC.md §5 policy).
- Verification states move only through the payment state machine
  (FINANCIAL-LEDGER.md §4.1) — a webhook or API response is the *only* path to
  `VERIFIED` for method=MPESA with a reference; counted cash follows the
  `finance.record_cash_verified` permission path.
- All provider interactions are audited (`MPESA_VERIFY_REQUESTED`, `MPESA_RESULT`).

## 4. Reconciliation & edge cases

- **Reconciliation job (cloud, M6+):** daily pull of transaction status for PENDING
  refs older than N hours; flags unresolvable ones for the owner.
- **Code typos:** caretaker enters `QGH7XJ2M9L` but tenant's real code differs →
  verification returns NOT_FOUND → payment REJECTED (visible, reversible by recording
  a corrected payment — history intact).
- **Two tenants claiming one code:** unique index blocks the second; conflict queue
  shows both; owner resolves (FINANCIAL-LEDGER.md §5).
- **Pochi la Mama / Buy Goods (till) vs Paybill:** shortcode type mapping configured
  per organization property; webhook matching uses the org's shortcodes table.
- **Timezones:** M-Pesa timestamps parsed as EAT (Africa/Nairobi); stored UTC.

## 5. Configuration & security

- Credentials (consumer key/secret, passkey, certificates) stored server-side
  (cloud) or in OS-keystore-encrypted app settings (direct device verification, rare);
  never in the repo, never in the op-log.
- Webhook endpoints: HTTPS only, Safaricom IP allow-list awareness + shared-secret
  validation + timestamp window + replay protection.
- Sandbox↔production is a config flag; the app displays a persistent "TEST MODE"
  banner and watermarks receipts while any sandbox provider is active — a sandbox
  verification can never masquerade as production truth.

## 6. Test strategy

- Contract tests against recorded sandbox fixtures (replayed through
  `FixtureProvider`).
- Negative suite: wrong amount, stale code, foreign-org shortcode, replayed webhook,
  duplicate webhook, malformed payload.
- The "never fake it" guard: a test asserts `DarajaSandboxProvider` cannot be
  constructed when `KITABU_ENV=production`, and that no other provider implementation
  returns VERIFIED without a provider-shaped response object.
