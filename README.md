# Kitabu — Offline-First Property Management for Kenyan Landlords

> **Kitabu** (Kiswahili: *book*) — *"All my landlord books in one simple application."*

Kitabu replaces the exercise books, receipt books and rent registers Kenyan landlords
use today with a **simple, offline-first, financially trustworthy** digital system that
works on a budget Android phone and an old Windows laptop — with optional cloud backup
and multi-device sync that **never** requires internet for core operation.

## Status

| Milestone | Scope | Status |
|---|---|---|
| M0 | Architecture & design package | ✅ complete (`docs/`) |
| M1 | Core foundation — local DB, ids/HLC/money, org/property/tenant/tenancy services, audit + op-log | ✅ complete |
| M2 | Financial core (ledger, payments, arrears, receipts) | ✅ complete — **114/114 tests green** |
| M3+ | App shells, operations, local sync, cloud, M-Pesa, AI | see [docs/ROADMAP.md](docs/ROADMAP.md) |

## Architecture in one paragraph

One **shared TypeScript core** (`@kitabu/core`, zero runtime dependencies) contains the
domain, the SQLite-backed local database, application services, the audit trail and the
synchronization op-log. The Android app (React Native), the Windows app (Electron) and
the future cloud server (NestJS/PostgreSQL) all execute **the same core** — so the
financial rules and the sync/conflict policies exist exactly once. Every device keeps a
full local database (the operational database, not a cache); sync is an append-only
operation log exchanged over local Wi-Fi (QR pairing) and, optionally, the cloud.

## Repository layout

```
docs/               Design package (PRD, architecture, database, sync, security, …)
packages/core/      @kitabu/core — shared core (pure TypeScript, zero deps)
  src/foundation/   UUIDv7/ULID ids · hybrid logical clocks · Money (KSh) · phones · errors
  src/db/           SqlitePort · schema v1+v2 + migrations · Node adapter (node:sqlite)
  src/domain/       Row types & enums (schema mirror)
  src/foundation/   … + sha256/base64/canonical JSON · amounts-in-words (Kiswahili-ready)
  src/services/     Organization · Property · Tenant · Tenancy · Audit · op-log recorder
                    · Ledger · Payment · Receipt (Ed25519-signed, immutable)
  test/             17 suites, 114 tests (node:test, zero-dependency)
apps/               Application shells (M3: React Native + Electron)
server/             Cloud API (M6: NestJS + PostgreSQL)
```

## Quickstart

Requires Node.js ≥ 22.18 (no other dependencies — the core is dependency-free):

```bash
npm install        # dev tooling only (typescript, @types/node)
npm test           # run the core test suites
npm run typecheck  # strict TypeScript check
```

Try the core interactively (charge rent, record an M-Pesa payment, issue a receipt):

```bash
node --disable-warning=ExperimentalWarning -e "
import('./packages/core/src/node.ts').then(({ openKitabuInMemory }) => {
  const k = openKitabuInMemory();
  k.bootstrap({ organizationName: 'Wilson Properties', landlordName: 'Wilson', deviceName: 'Laptop', platform: 'WINDOWS' });
  const p = k.services.property.createProperty({ name: 'Green View Apartments', town: 'Nairobi' });
  const u = k.services.property.addUnit({ propertyId: p.id, label: 'A-12' });
  const t = k.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });
  const tn = k.services.tenancy.startTenancy({ tenantId: t.id, unitId: u.id, rentMinor: 1200000, startDate: '2026-09-01' });
  k.services.ledger.generateMonthlyCharges('2026-09');
  const pay = k.services.payment.recordPayment({ tenancyId: tn.id, amountMinor: 1200000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L' });
  k.services.payment.verifyPayment(pay.id, 'Code matched the M-Pesa message');
  const rec = k.services.receipt.issueReceipt(pay.id);
  console.log('Receipt', rec.receipt.receipt_no, '—', rec.snapshot.amountWords);
  console.log('Balance:', k.services.ledger.tenancyBalance(tn.id));
  console.log('Audit:', k.services.audit.list({ limit: 3 }).map(a => a.summary));
  k.close();
});"
```

## Non-negotiable principles (docs/PRD.md §11)

1. Offline operation is the default state, not a fallback mode.
2. The local database is authoritative for local operation.
3. Cloud is optional and never required for core landlord work.
4. Local device sync works without internet (QR pairing + Wi-Fi/hotspot).
5. Financial history is immutable and auditable — corrections are reversals, not edits.
6. AI never becomes the source of truth and never bypasses authorization.
7. One landlord's data can never leak to another landlord.
8. Simple enough for a non-technical Kenyan landlord; no enterprise bloat.

## Documentation

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements, personas, FR/NFR catalogue |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagrams, layering, offline architecture |
| [docs/TECHNOLOGY-DECISIONS.md](docs/TECHNOLOGY-DECISIONS.md) | Stack comparison (Flutter vs TS-everywhere vs .NET) + ADRs |
| [docs/DATABASE.md](docs/DATABASE.md) | Full local schema (v1–v3), cloud PostgreSQL + RLS |
| [docs/FINANCIAL-LEDGER.md](docs/FINANCIAL-LEDGER.md) | Ledger design, payment states, worked examples |
| [docs/SYNC.md](docs/SYNC.md) | Op-log protocol, pairing, conflicts, topology dedupe |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, device trust, encryption, tenant isolation |
| [docs/RECEIPTS.md](docs/RECEIPTS.md) | Receipt numbering, immutability, signatures, tamper-evidence |
| [docs/M-PESA.md](docs/M-PESA.md) | Daraja provider abstraction, verification workflow |
| [docs/AI.md](docs/AI.md) | AI/tool boundary, offline behavior, safety rules |
| [docs/UX.md](docs/UX.md) | Screen map, payment flow, offline communication |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M10 with exit criteria |
| [docs/RISKS.md](docs/RISKS.md) | Architectural risks and self-challenge |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Cloud topology, CI/CD, local development |

## License

Proprietary — © Wilson Ndiko. All rights reserved.
