# Technology Decisions

> Decision record for Phase 0. Criteria and weighting from the project brief (§56):
> offline capability, cross-platform support, reliability, performance, maintainability,
> developer productivity, synchronization capability, long-term scalability, security, cost.

## 1. Candidates compared

| # | Stack | Android | Windows | Local DB | Cloud |
|---|---|---|---|---|---|
| **A** | **TypeScript everywhere (chosen)** | React Native + Expo | Electron (Node 22) | SQLite via adapters; shared TS core | NestJS + PostgreSQL |
| B | Flutter/Dart | Flutter | Flutter desktop | Drift/SQLite | NestJS (TS) or Dart shelf |
| C | .NET | MAUI/Android | MAUI/WPF or Avalonia | SQLite (sqlite-net / EF Core) | ASP.NET Core + PostgreSQL |

## 2. Weighted evaluation

Scores 1–5 (5 best). Weights reflect this product's non-negotiables (offline + sync
correctness outrank everything else).

| Criterion (weight) | A: TS everywhere | B: Flutter | C: .NET |
|---|---|---|---|
| Offline-first capability (×3) | 5 | 5 | 4 |
| **Sync correctness: one implementation across clients & server (×3)** | **5** | **2** | **2** |
| Cross-platform coverage (×2) | 4 (two UI shells) | 5 (one UI codebase) | 4 |
| Performance on budget devices (×2) | 4 (Hermes RN; Electron ~200–300MB) | 5 | 4 |
| Maintainability / hiring (×2) | 5 (one language, huge TS talent pool incl. Kenya) | 4 | 3 (smaller local pool) |
| Ecosystem for M-Pesa integration (×1) | 5 (Daraja is HTTP/JSON; Node SDKs abundant) | 4 | 4 |
| Testability of the critical core (×2) | 5 (core runs headless in Node with zero setup) | 4 (dart test) | 4 |
| Long-term scalability (×1) | 4 | 4 | 5 |
| Security tooling (×1) | 4 | 4 | 5 |
| **Weighted total (max 90)** | **78** | **69** | **64** |

## 3. The decisive argument

The highest-risk subsystem in this product is **synchronization correctness** — duplicate
payments, lost records, and divergent financial history are the failure modes the brief
calls unacceptable. Every viable stack has good SQLite and good UI options; the
differentiator is *how many independent implementations of the sync + financial rules must
exist and stay in agreement*:

- **Stack A:** the sync protocol, conflict policies, ledger math, permission checks and
  receipt logic are written **once** in `@kitabu/core` (dependency-free TypeScript) and
  executed by the Android app, the Windows app, **and the cloud server** (NestJS imports
  the same package). One implementation, one test suite, one source of truth.
- **Stack B (Flutter):** clients would share a Dart core, but the NestJS/Postgres cloud
  (the pragmatic server choice) would need a **second** implementation of the op-apply
  and conflict-policy logic in TypeScript — the exact code where silent divergence causes
  duplicate payments. Alternative: a Dart server (smaller ecosystem, fewer hires,
  weaker managed-platform support). Flutter's single-UI-codebase advantage does not
  outweigh this.
- **Stack C:** excellent runtime, but C# MAUI on Android is the weakest mobile option,
  and the sync logic would still be implemented twice (client/server share language, but
  local SQLite access patterns and serialization differ enough to force duplication);
  hiring pool in Kenya for .NET desktop is thin.

Additional practical factor: the development environment for this project (GitHub +
npm only) can build, typecheck and test a zero-dependency TypeScript core end-to-end,
so **every milestone ships verified by tests**, satisfying the brief's agent rules
("run tests before proceeding").

## 4. Windows shell: Electron vs Tauri vs React Native for Windows

| Option | Pros | Cons for this product |
|---|---|---|
| **Electron (chosen)** | Full Node 22 runtime → `@kitabu/core` runs natively, `node:sqlite`/better-sqlite3, mDNS + HTTP server for LAN sync host, mature auto-update, mature code signing | ~80–120 MB install, ~200–300 MB RAM |
| Tauri | Tiny binaries, system WebView2 | Rust backend: SQLite + mDNS + sync server require Rust modules → third implementation surface, two languages |
| React Native for Windows | Same UI code as Android | Native-module ecosystem on Windows is thin (no solid SQLite/JSI or TCP-server story) → would break the shared-core promise at the most critical layer |

Electron's costs are acceptable against the NFR targets (300 MB RAM on 4 GB laptops is
within budget), and its Node runtime makes the Windows app the **natural sync host** for
local device sync — the landlord's laptop is the rendezvous point for caretaker phones.

## 5. Local database choice

- **SQLite** (not Realm/IndexedDB/Watermelon): it *is* the device database everywhere,
  has rock-solid tooling, partial indexes, triggers (used to enforce financial
  immutability), FTS5 for offline search, and SQLCipher for encryption.
- Access via a small **`SqlitePort`** interface (`exec/prepare/run/get/all/transaction`)
  so the same core runs on Node (`node:sqlite` today; `better-sqlite3`+SQLCipher in the
  Electron shell) and React Native (`react-native-quick-sqlite`/`op-sqlite` with
  SQLCipher). A conformance test suite exercises the port, so adapters are provably
  equivalent.
- Cloud uses **PostgreSQL** (RLS for tenant isolation) — schema is documented side by
  side in DATABASE.md; the op-log protocol is DB-agnostic.

## 6. Identifier & time strategy

- **Row IDs: UUIDv7** (time-ordered, generated on-device; no server coordination,
  no collisions, index-friendly).
- **Op IDs: ULID** (lexicographically sortable — used as sync cursors).
- **Hybrid Logical Clocks (HLC)** for change ordering that tolerates device clock skew.
- All timestamps stored as ISO-8601 UTC strings; organization timezone defaults to
  `Africa/Nairobi` (EAT, no DST) for rental-month boundaries.

## 7. ADR summary

| ADR | Decision | Status |
|---|---|---|
| 001 | TypeScript shared core + RN (Android) + Electron (Windows) + NestJS/Postgres cloud | Accepted |
| 002 | SQLite as the only local database, behind `SqlitePort`; SQLCipher encryption in shells | Accepted |
| 003 | Op-log sync protocol (append-only operation log) shared by devices and server | Accepted |
| 004 | UUIDv7 row IDs, ULID op IDs, HLC ordering — all generated on-device | Accepted |
| 005 | Money as integer minor units; KES display formatting | Accepted |
| 006 | Soft delete + tombstones for synced entities; no hard deletes of financial history | Accepted |
| 007 | Per-entity conflict policies (not blanket LWW); payments/receipts immutable inserts | Accepted |
| 008 | Receipt numbering via per-device reserved blocks per organization | Accepted |
| 009 | M-Pesa behind `MpesaProviderPort`; verification only from real provider responses | Accepted |
| 010 | AI behind `AiProviderPort`, tool-calling only, never direct data access | Accepted |
| 011 | `node:sqlite` for core dev/tests (Node ≥22); app shells select their adapter | Accepted |
| 012 | Zero runtime dependencies in `@kitabu/core` | Accepted |

### ADR-012 note — zero-dependency core

`@kitabu/core` uses only the language and platform APIs (crypto via WebCrypto
`globalThis.crypto`, SQLite via injected adapter, time via injected clock). This keeps
the core instantly buildable, auditable, portable to RN's JS runtime, and immune to
dependency-supply risk. Libraries are admitted only at app/server shell level.
