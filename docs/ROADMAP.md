# Development Roadmap

> Small, coherent, test-verified milestones (brief §59–60). Each milestone ends green
> (all tests pass), documented, and demoable before the next begins. Phases map to the
> brief's Phase 0–8.

## M0 — Architecture & design (Phase 0) ✅ **this delivery**

Design package: PRD, architecture, technology decisions, database, financial ledger,
sync, security, AI, M-Pesa, receipts, UX, deployment, risks.
**Exit:** docs reviewed & coherent; risks acknowledged.

## M1 — Core foundation (Phase 1 start) ✅ **this delivery (code)**

`@kitabu/core` (TypeScript, zero runtime deps):
- Foundation: UUIDv7/ULID ids, hybrid logical clock, `Money`, Kenyan phone
  normalization, friendly errors, injectable clock.
- SQLite port + Node adapter (`node:sqlite`), schema v1 + migration runner.
- Services: organization bootstrap, properties/buildings/units, tenants,
  tenancies (start/end/move), effective-dated rent rates, audit log, op-log recorder.
- Test suites: ids, HLC, money, phone, bootstrap, property, tenancy, tenant, audit,
  change-log invariants, schema constraints.
**Exit criteria:** `npm test` green; every mutation writes data+audit+op-log
atomically; tenancy history provably preserved on moves; rent changes append-only.

## M2 — Financial core (Phase 2) — the most-tested milestone ✅ **complete**

- Ledger entries (charges/payments/adjustments/reversals), monthly charge generation
  (idempotent, effective-dated rates), payment state machine + immutability triggers,
  waterfall allocation, arrears/month-status queries, duplicate-reference handling.
- Receipt service: numbering blocks, snapshots, digests, Ed25514 org key, PDF template,
  void+reissue. Signature images.
- Tests: every FINANCIAL-LEDGER.md §5 worked example as a fixture; invariant suite
  (FINANCIAL-LEDGER.md §7); trigger-tamper attempts.
**Exit:** ✅ red-line tests pass incl. reversal, duplicate ref, rent change history;
receipts immutable at DB level. Delivered: schema v2 (7 tables, 9 integrity
triggers, v1→v2 in-place migration), ledger/payment/receipt services, Ed25519
receipt signing, **114/114 tests green** (all FINANCIAL-LEDGER §5 worked examples
as executable fixtures). The PDF template lands with the app shells (M3) — the
signed, frozen snapshot it renders is already in place.

## M3 — App shells (Phase 1 finish)

- Electron Windows app (installer, auto-update scaffold, SQLCipher, DPAPI key seal,
  PIN unlock, LAN sync-host capability stub).
- React Native Android app (Expo dev-client, SQLCipher store, PIN/biometric).
- Screens: onboarding, unlock, dashboard, properties, tenants, record payment
  (≤5 taps), payments, receipts (PDF), settings; offline chip; friendly errors.
- Local encrypted backup export/restore (Argon2id passphrase).
**Exit:** "Green View" single-device walkthrough on Windows + Android fully offline;
NFR-02/03/04/12 measured.

## M4 — Property operations (Phase 3)

Expenses, maintenance workflow, documents (content-addressed, lazy sync), reports
(collection, statement, expenses, occupancy — PDF/CSV), global search (FTS5).
**Exit:** reports match ledger tests; search < 100 ms on 10k-row fixture.

## M5 — Local device sync (Phase 4)

QR pairing, mDNS + manual-IP discovery, encrypted transports (pinned TLS host /
ECDH+AEAD P2P), op-log exchange with per-peer watermarks, conflict engine + review
screen, device registry + revocation, op-log compaction + snapshot catch-up.
**Exit:** the full 3-day-offline Green View scenario (brief §64) as an automated
3-device integration test; tamper/replay/revoked-device negative tests green.

## M6 — Cloud (Phase 5)

NestJS API + PostgreSQL (RLS), accounts (phone OTP), device attestation, cloud sync
(op-log apply reusing core policies), org snapshot + migration (local→cloud without
duplicates), device recovery on fresh install, org isolation test suite, backups.
**Exit:** fresh-install restore reproduces the org exactly; cross-org access tests
all 403/404; brief §64 cloud tail passes.

## M7 — M-Pesa (Phase 6)

Daraja sandbox provider, C2B webhook inbox + matching, verify-by-code flow, STK push,
approval settings, TEST-mode watermark; production cutover config. Never-fake guard
tests.
**Exit:** sandbox end-to-end: tenant pays sandbox paybill → webhook → payment VERIFIED
→ receipt issued; offline-recorded code verified on later connectivity.

## M8 — AI assistant (Phase 7)

`AiProviderPort` + OpenAI-compatible provider, tool dispatcher with role allow-list,
read-only Q&A grounded in tools, proposal→confirmation write flows, offline
degradation, prompt-injection fixture tests.
**Exit:** brief §42 questions answered from real data with provenance; §43
confirmation flow enforced in code; AI-off app fully functional.

## M9 — Commercialization (Phase 8)

Plans/entitlements service (config-driven limits), cached entitlements with grace,
subscription billing (M-Pesa Daraja + card via provider abstraction), onboarding
improvements, opt-in diagnostics, support export.
**Exit:** plan change + 7-day offline grace scenario; offline core never blocks.

## M10 — Hardening & beta

Security review, performance on low-end devices, crash-free beta, docs for support,
Play Store + Windows signed releases, final Green View acceptance with real users.

---

## Cross-milestone rules

1. No milestone starts while the previous is red.
2. Every financial rule ships with its test in the same milestone.
3. Working functionality is never destroyed for new features (brief §60).
4. Decisions that deviate from docs are recorded in the relevant doc + commit message.
