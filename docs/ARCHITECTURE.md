# Kitabu Digital — Architecture

## 1. System overview

Offline-first + local-sync + optional-cloud. The local database on every device is the **operational database**, not a cache.

```
                    ┌───────────────────────────────┐
                    │        OPTIONAL CLOUD          │
                    │  Cloud API (Node/Fastify)      │
                    │  PostgreSQL (multi-tenant)     │
                    │  Object storage (documents)    │
                    │  Auth service                  │
                    │  AI gateway (provider-agnostic)│
                    │  M-Pesa verification adapters  │
                    └──────────────┬─────────────────┘
                                   │  HTTPS (optional)
                 ┌─────────────────┴─────────────────┐
                 │                                   │
        ┌────────▼─────────┐               ┌─────────▼────────┐
        │  WINDOWS APP     │               │  ANDROID APP     │
        │  Tauri shell     │               │  Capacitor shell │
        │  ┌────────────┐  │               │  ┌────────────┐  │
        │  │ Kitabu UI  │  │               │  │ Kitabu UI  │  │
        │  │ (React)    │  │               │  │ (React)    │  │
        │  ├────────────┤  │               │  ├────────────┤  │
        │  │ Local Core │  │               │  │ Local Core │  │
        │  │ Service    │  │               │  │ Service    │  │
        │  ├────────────┤  │               │  ├────────────┤  │
        │  │ SQLite     │  │               │  │ SQLite     │  │
        │  └────────────┘  │               │  └────────────┘  │
        └────────┬─────────┘               └─────────┬────────┘
                 │        LOCAL SYNC (no internet)   │
                 └───────── Wi-Fi LAN / hotspot ─────┘
                       mTLS over TCP, QR pairing
```

### Layering (every app, and the cloud)

```
Presentation (React UI / AI assistant / CLI)
      ↓ (REST/IPC — never SQL)
Application Services (use-cases: RecordPayment, IssueReceipt, MoveTenant…)
      ↓
Domain (@kitabu/core: ledger engine, payment state machine, billing, money, ids)
      ↓
Repositories (SQL lives here; change-log written here)
      ↓
Infrastructure (SQLite locally / PostgreSQL in cloud / sync transport / PDF / M-Pesa adapters)
```

Rules enforced by this layering:
- Financial logic lives in `@kitabu/core`, written once, shared by desktop, mobile and cloud.
- UI never touches the database.
- The sync engine is a subsystem beside the application services, not inside the UI.
- The AI talks to application services through tools; it never reaches repositories.
- M-Pesa is an interface (`PaymentVerificationProvider`) with sandbox/manual/production implementations.

### The Local Core Service

Both the Windows and Android apps embed the same **local core service**: application services + repositories + SQLite + sync engine, exposed to the UI over localhost. On Windows (Tauri) it runs as the app sidecar; on Android (Capacitor) the same TypeScript core runs in-process against the SQLite plugin. In development it runs as a plain Node process — which is exactly what this repository's `apps/server` is.

## 2. Technology decision

Two viable stacks were compared seriously:

### Stack A — Flutter everywhere
Flutter (Android + Windows desktop) + Drift/SQLite (+ SQLCipher), Dart domain layer; backend in Dart (serverpod) or TypeScript.

### Stack B — TypeScript everywhere (CHOSEN)
- **Domain core:** TypeScript (`@kitabu/core`), pure, no I/O.
- **UI:** React (one responsive codebase for desktop and mobile shells).
- **Windows:** Tauri (v2) shell — ~10 MB footprint, low RAM, fits 4 GB machines far better than Electron.
- **Android:** Capacitor + `@capacitor-community/sqlite` (SQLCipher support).
- **Local DB:** SQLite everywhere (better-sqlite3 on desktop/dev, capacitor-sqlite on Android). WAL mode, foreign keys ON.
- **Cloud:** Node.js/Fastify + PostgreSQL (row-level security per organization) + S3-compatible object storage.

| Criterion | Flutter (A) | TypeScript (B) |
|---|---|---|
| Offline capability | Excellent (Drift) | Excellent (SQLite everywhere) |
| Windows on 4 GB laptops | Good (~100 MB RAM) | Good with Tauri (~60–90 MB); Electron rejected |
| Android budget phones | Excellent | Good |
| **Shared business logic with cloud backend** | Weak (Dart server ecosystem is thin; ledger logic duplicated in two languages) | **Strong — the exact same ledger/sync code runs on device and in cloud** |
| Sync engine reuse | Device-only | Device + cloud (same conflict code both sides) |
| Local P2P sync plumbing | Platform channels needed | Node TCP/mDNS on desktop; Capacitor plugin on Android |
| Talent availability / maintainability (Kenya + global) | Good | Excellent |
| PDF, QR, crypto libraries | Good | Excellent |
| Risk | UI excellent, backend split-brain | Android needs care with background work |

**Winner: Stack B.** The deciding factor is rule §57/§61: *no duplicated business logic*. The financial ledger and the conflict-resolution engine are the two highest-risk components; in Stack B they are written once in TypeScript and executed identically on Windows, Android, and the cloud. Flutter's superior UI toolkit does not outweigh maintaining two implementations of the money code. (ADR-001; runner-up documented so this can be revisited if Android constraints demand it.)

Rejected outright: Electron (RAM on 4 GB targets), Realm (sync tied to a discontinued commercial cloud), server-generated IDs (offline creation), "last write wins everywhere" (financial data).

## 3. Offline architecture

- Every read and write goes to local SQLite inside a transaction. There is no "online mode" code path — networking only exists inside the sync subsystem.
- IDs are **prefixed ULIDs** (`pay_01J8…`) generated on-device: sortable by creation time, collision-safe across devices (§ docs/DATABASE.md).
- Every synced table carries `org_id, version, updated_at, deleted_at, origin_device_id`; every committed write appends to `change_log` **in the same transaction** (repository responsibility).
- Monthly rent charges are generated **idempotently and lazily** by the billing service (`ensure charges exist for every open tenancy up to current period`), so no scheduler or connectivity is needed.
- Receipt numbers must be unique without coordination: `KD-<deviceCode>-<seq>` per device (§ docs/DATABASE.md).
- Entitlements/subscription state (Phase 8) are cached locally with a grace window; expiry never blocks reading data or recording payments.

## 4. Sync topology

Three levels (full protocol in docs/SYNC.md):
1. **Single device** — everything above.
2. **Local device↔device** — mDNS discovery + QR pairing + mutually-authenticated encrypted channel on the LAN/hotspot; exchange of change-log deltas; per-entity conflict policies.
3. **Optional cloud** — same change-log delta protocol over HTTPS to the multi-tenant cloud, which acts as *another replica plus durable backup*, not as the authority for local operation. Dedup across paths (phone→laptop→cloud→phone) is by change-id, not by arrival path.

## 5. Multi-tenancy (cloud)

- One PostgreSQL cluster, shared schema, `organization_id` on every row, **PostgreSQL row-level security** with the org id bound per-connection from the authenticated session — isolation enforced below the application code.
- Object storage keys are prefixed `orgs/{org_id}/…`; signed URLs scoped per org.
- API authorization: every request resolves (user, org, role, device) and every service checks permissions; the client is never trusted.
- Sync uploads are validated server-side: an authenticated device may only submit changes whose `org_id` matches its registration.

## 6. Architectural risks (self-challenge)

| Risk | Mitigation |
|---|---|
| P2P sync on Android (Wi-Fi Direct flakiness) | Primary path is plain LAN/hotspot TCP + mDNS; Wi-Fi Direct is an optimization, not a dependency. Worst case: landlord's phone hotspot, which is ubiquitous in Kenya. |
| Same TS core on Android via Capacitor may hit perf limits on huge portfolios | Ledger queries are SQL aggregates, not JS loops; benchmark at 10k payments in CI. Escape hatch: move hot queries into SQL views. |
| Receipt numbering per device confuses users expecting one sequence | Number format shows device code explicitly; docs + UI explain "one receipt book per device", exactly like physical receipt books. |
| Lazy charge generation drift between devices | Charge generation is deterministic (tenancy id + period ⇒ same charge id on every device), so two devices generating the same month's charge produce the *same* record — idempotent by construction. |
| Clock skew across devices | Hybrid logical clocks (HLC) in the change log; wall time is display-only. |
| SQLCipher licensing/perf on low-end Android | Encrypt at OS level (Android file-based encryption) + app PIN; SQLCipher optional per-device setting. |
