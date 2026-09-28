# Kitabu Digital — Roadmap & Milestone Status

Phases follow the project brief (§59). Each milestone is small, tested, and never breaks earlier work.

## Phase 0 — Architecture ✅
Design docs in `docs/` (PRD, architecture + tech decision, database, sync, security, M-Pesa, AI, UX). **Done.**

## Phase 1 — Local Core ✅ (this repo)
- M1.1 Monorepo, `@kitabu/core` domain package with tests ✅
- M1.2 Local core service: SQLite schema, migrations, change-log writes ✅
- M1.3 Onboarding: organization, first property, bulk unit creation ✅
- M1.4 Tenants + tenancies (move-in, history preserved) ✅
- M1.5 Web UI shell: Home, Properties, Tenants, offline-first ✅
- M1.6 Staff users (Owner/Manager/Caretaker) + PIN lock screen + role-gated routes ✅

## Phase 2 — Financial Core ✅ (this repo)
- M2.1 Ledger engine (charges/payments/adjustments/reversals) + heavy tests ✅
- M2.2 Idempotent monthly charge generation (deterministic ids) ✅
- M2.3 Record payment flow, payment state machine, duplicate reference rejection ✅
- M2.4 Verification queue (manual provider) ✅
- M2.5 Immutable receipts with device-scoped numbering + printable view ✅
- M2.6 Arrears view ✅ · Audit log ✅

## Phase 3 — Property Operations (partially in this repo)
- M3.1 Expenses ✅ · M3.2 Maintenance workflow ✅ · M3.3 Global search ✅
- M3.5 Reports (collection / expenses / occupancy) + CSV export ✅
- M3.6 Digital signature on receipts (upload, frozen into receipt snapshot at issuance, synced) ✅
- M3.4 Documents/attachments ◻ · PDF export (print-to-PDF works; native export ◻)

## Phase 4 — Local Device Sync ✅ v1 (this repo)
- M4.1 Change-log exchange engine: idempotent apply, dedup by change_id, relay-safe ✅
- M4.2 Pairing: one-time code ceremony + full-history join (QR rendering of the same code: ◻) ✅
- M4.3 Per-entity conflict policies: payment status priority + automatic ledger reconciliation,
  deterministic receipt-race winner, deterministic double-move-in resolution, LWW for profiles ✅
- M4.4 Peer HTTP endpoints with device auth (shared org key) + revocation enforcement ✅
- M4.5 Sync UI: pairing, peers, Sync Now, join-from-onboarding, offline chip ✅
- M4.6 §64 acceptance scenario automated (three days offline → converge, no dupes) ✅
- M4.7 Per-staff identities on any device: lock screen asks "who is using this device?" after
  pairing/restore; staff sync to all devices and sign in with their own PIN + role ✅
- M4.8 Encrypted local backup (AES-256-GCM, scrypt passphrase) + restore-as-local-join on a fresh
  device (replays history through the sync engine — receipt numbers survive, later sync is safe) ✅
- Remaining: mDNS auto-discovery ◻ · Noise/mTLS transport encryption (currently shared-key auth on
  trusted LAN) ◻ · sync of documents/audit log (audit stays device-local by design for now) ◻

## Phase 5 — Cloud ◻
Optional accounts, multi-tenant cloud API (Fastify + Postgres RLS), local→cloud migration, multi-device sync, backup, device recovery.

## Phase 6 — M-Pesa verification ◻
Statement import matching → Daraja transaction-status provider (sandbox first, clearly separated) → review queue. Recording/verifying only — never payment processing.

## Phase 7 — AI ◻
Read-only tools → confirmation-gated mutations → offline command parser.

## Phase 8 — Commercialization ◻
Plans/entitlements with offline grace, billing, onboarding polish, telemetry (privacy-appropriate), support diagnostics.

## Engineering rules recap
Smallest coherent increment → tests → edge cases → document → proceed. Never rewrite wholesale; never break working functionality; financial logic only in `@kitabu/core`.
