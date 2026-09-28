# Kitabu Digital

> **"All my landlord books in one simple application."**

Kitabu Digital is an **offline-first property management system for Kenyan landlords and property managers**. It replaces the exercise books, rent books, receipt books and tenant registers that Kenyan landlords use today — without forcing them to learn complicated enterprise software.

## Core principles (non-negotiable)

1. **Offline operation is a core feature, not a fallback.** Every device carries its own authoritative local database.
2. **Cloud is optional.** The app is fully usable without ever creating an account.
3. **Kitabu records payments — it never processes them.** Tenants pay the landlord directly (M-Pesa, cash, bank). The manager/caretaker *records* the payment in Kitabu, which verifies it, posts it to the rent ledger, and generates the digital receipt. No money ever moves through Kitabu.
4. **Financial history is immutable and auditable.** Corrections happen through reversals and adjustments, never silent edits.
5. **Devices sync locally without internet** (landlord laptop ↔ caretaker phone over local Wi-Fi), and optionally to the cloud.
6. **One landlord's data must never leak to another landlord.**

## Repository layout

```
docs/               Design documents (start with docs/ARCHITECTURE.md)
packages/core/      @kitabu/core  — pure TypeScript domain logic (ledger, money, payment states, billing)
apps/server/        @kitabu/server — local core service: SQLite + application services + REST API
apps/web/           @kitabu/web   — the Kitabu UI (React), served by the local core service
```

## Design documents

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements, target market, scope |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, technology comparison & decision, risks |
| [docs/DATABASE.md](docs/DATABASE.md) | Full schema, ledger design, identifiers, change tracking |
| [docs/SYNC.md](docs/SYNC.md) | Local device sync, cloud sync, conflict resolution per entity |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, device trust, encryption, tenant isolation |
| [docs/MPESA.md](docs/MPESA.md) | Record-and-verify model (no payment processing), provider abstraction |
| [docs/AI.md](docs/AI.md) | AI assistant boundary, tool calling, offline behaviour |
| [docs/UX.md](docs/UX.md) | Screen-by-screen navigation, Kenyan-context UX rules |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Development phases and milestone status |

## Running locally (development)

```bash
npm install
npm test                 # domain test suite (ledger, billing, payment states)
npm run dev              # starts local core service (API, port 4000) + web UI (port 5173)
```

The app stores its SQLite database in `apps/server/data/kitabu.db` (created on first run). Delete it to start fresh.

## Status

See [docs/ROADMAP.md](docs/ROADMAP.md). Phases 0–2 (design, local core, financial core) are implemented; Phase 3 (operations) partially; sync/cloud/M-Pesa/AI are designed but not yet implemented.
