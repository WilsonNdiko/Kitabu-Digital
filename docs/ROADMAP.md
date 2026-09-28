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
- M1.6 Local user profile + PIN (hash stored; full lock-screen wiring: Phase 4 hardening) ◻

## Phase 2 — Financial Core ✅ (this repo)
- M2.1 Ledger engine (charges/payments/adjustments/reversals) + heavy tests ✅
- M2.2 Idempotent monthly charge generation (deterministic ids) ✅
- M2.3 Record payment flow, payment state machine, duplicate reference rejection ✅
- M2.4 Verification queue (manual provider) ✅
- M2.5 Immutable receipts with device-scoped numbering + printable view ✅
- M2.6 Arrears view ✅ · Audit log ✅

## Phase 3 — Property Operations (partially in this repo)
- M3.1 Expenses ✅ · M3.2 Maintenance workflow ✅ · M3.3 Global search ✅
- M3.4 Documents/attachments ◻ · M3.5 Reports + CSV/PDF export ◻ · M3.6 Signature upload UI ◻

## Phase 4 — Local Device Sync ◻
Device registration/QR pairing → mDNS discovery → encrypted transport → change-log exchange → conflict handling (per docs/SYNC.md) → sync UI. Test entirely without internet.

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
