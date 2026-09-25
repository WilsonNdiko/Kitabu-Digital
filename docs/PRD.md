# Kitabu — Product Requirements Document

> **Kitabu** (Kiswahili: *book*) — *"All my landlord books in one simple application."*

Version: 0.1 (Phase 0) · Status: Approved for Milestone 1 · Owner: Wilson Ndiko

---

## 1. Problem

Most Kenyan landlords manage rentals with exercise books, receipt books, rent books,
tenant registers, notebooks, WhatsApp messages and Excel sheets. This creates:

- **Lost money** — arrears that are forgotten, payments recorded twice, no reliable balances.
- **Lost records** — books get lost, damaged, or leave with a caretaker.
- **No accountability** — caretakers collect cash with no verifiable trail.
- **No visibility** — the landlord cannot answer "who hasn't paid?" without phoning everyone.
- **No audit trail** — disputes with tenants are settled by argument, not records.

Existing property-management software is cloud-first, enterprise-shaped, foreign-context,
and unusable offline — wrong product for this market.

## 2. Vision

A **simple, offline-first, financially trustworthy digital replacement for the landlord's
books**, usable on a budget Android phone and an old Windows laptop, with optional cloud
backup and multi-device sync.

**The test of success:** a 60-year-old landlord who has used a rent book for 20 years can
record a payment, generate a signed receipt, and see who owes her — **without internet and
without training**.

## 3. Target users (personas)

| | Landlord A | Landlord B | Landlord C |
|---|---|---|---|
| Portfolio | 1 apartment, 20 units | 4 properties, 120 units | ~15 standalone houses |
| Staff | 1 caretaker | 5 managers/caretakers | none |
| Devices | Android phone | Laptop + phone; caretaker phones | Android phone |
| Internet | Unreliable | Mostly available | Rare |
| Needs | Simple record + receipts | Roles, delegation, arrears across properties | Dead-simple tenant list |

The system must fit Landlord C without feeling enterprise, and stretch to Landlord B
without breaking.

## 4. Jobs to be done

1. Know exactly **who has paid, who hasn't, and how much is owed** — per house, per month.
2. Give every paying tenant a **professional receipt** immediately, with my signature.
3. Let my **caretaker record payments** without being able to hide or change history.
4. Keep records **even when there is no network for days**.
5. Recover everything if a **phone is lost**.
6. Move a tenant to another house **without losing their payment history**.
7. See **expenses vs collections** per property.
8. Settle disputes with a **tenant statement** (charges, payments, balance).
9. Eventually: get **cloud backup and multi-device access** (optional, paid).

## 5. Product pillars (in priority order)

1. **Offline is normal mode** — every core feature works with zero connectivity.
2. **Financial trustworthiness** — ledger-based books, immutable history, verifiable receipts.
3. **Simplicity** — digital notebook, not enterprise software. Terminology the user knows
   (Houses, Tenants, Payments, Receipts).
4. **Kenyan by default** — KSh, M-Pesa references, 07xx phone numbers, monthly rent,
   deposits, caretakers.
5. **Optional cloud** — backup, sync, recovery — a benefit, never a requirement.

## 6. Scope

### 6.1 In scope — v1 (Milestones 1–5, "local-first product")

- Local organization, properties, buildings, units (houses), tenants, tenancies.
- Rent ledger: charges, payments (cash / M-Pesa reference / bank), allocations,
  arrears, advance rent, adjustments, reversals.
- Digital receipts (PDF) with per-property signature images + tamper-evidence.
- Arrears view + tenant statements + collection/expense/occupancy reports (PDF/CSV).
- Expenses and maintenance requests.
- Local device-to-device sync over Wi-Fi/hotspot with QR pairing.
- Local encrypted backup + restore.
- PIN/biometric app lock; roles: Owner, Manager, Caretaker.

### 6.2 In scope — v2 (Milestones 6–8)

- Optional cloud accounts; cloud backup & multi-device sync over internet.
- Local → cloud migration for existing offline data.
- Device management & revocation in the cloud.
- M-Pesa verification (Daraja sandbox → production) and manager approvals.
- AI assistant (queries first, then confirmable actions).
- Subscriptions/plans with offline-safe entitlements.

### 6.3 Explicitly out of scope (v1/v2)

- Online tenant portals and tenant-facing apps (later).
- Online rent collection via the platform (no funds handling — v1 verifies M-Pesa
  payments made to the landlord's own Paybill/Till; the product never touches money).
- Utility billing integrations, smart meters.
- Multi-currency (KSh only; schema reserves a currency field).
- iOS, macOS, Linux desktop clients (architecture permits; not prioritized).

## 7. Functional requirements (key)

Each requirement has an ID used across docs and tests. Phase tags: P1 local core,
P2 financial core, P3 operations, P4 local sync, P5 cloud, P6 M-Pesa, P7 AI, P8 commercial.

| ID | Requirement | Phase |
|---|---|---|
| FR-01 | Create organization, properties, buildings, units offline | P1 |
| FR-02 | Register tenant with minimal required fields; configurable unit terminology | P1 |
| FR-03 | Tenancy lifecycle: start, end, move house — history preserved | P1 |
| FR-04 | Effective-dated rent changes; historical rent never rewritten | P1/P2 |
| FR-05 | Ledger-based finances: charges + payments + adjustments + reversals = balance | P2 |
| FR-06 | Payments: cash, M-Pesa (ref), bank; explicit states incl. pending verification | P2 |
| FR-07 | Duplicate M-Pesa reference detection (per organization) | P2 |
| FR-08 | Verified payments & issued receipts are immutable; corrections via reversals | P2 |
| FR-09 | Auto water-fall allocation of payments to oldest outstanding charges | P2 |
| FR-10 | Arrears dashboard: unpaid/partial/paid per house, filters by property/month | P2 |
| FR-11 | Receipt PDF auto-assembled from data; per-property signatures; numbering | P2 |
| FR-12 | Receipt tamper-evidence (digest + signature, QR verification) | P2 |
| FR-13 | Expenses with categories, property, attachments | P3 |
| FR-14 | Maintenance workflow: reported → assigned → in-progress → completed | P3 |
| FR-15 | Documents (agreements, photos) attached to entities; offline-available | P3 |
| FR-16 | Global offline search: tenant, house, ref code, receipt number, expense | P3 |
| FR-17 | Reports: collection, tenant statement, expenses, occupancy (PDF/CSV) | P3 |
| FR-18 | QR-based device pairing; encrypted LAN/hotspot sync without internet | P4 |
| FR-19 | Sync conflict handling per entity policy; conflict review queue for owner | P4 |
| FR-20 | Idempotent sync; no duplicate payments across any sync topology | P4 |
| FR-21 | Device registry: list, rename, revoke; revoked devices cannot sync | P4/P5 |
| FR-22 | Local encrypted backup (manual + automatic) and restore | P4 |
| FR-23 | Optional cloud account; local→cloud migration without duplicates | P5 |
| FR-24 | Cloud multi-device sync; device recovery flow on new install | P5 |
| FR-25 | Strict organization isolation in cloud (server-enforced) | P5 |
| FR-26 | M-Pesa reference verification via Daraja (provider abstraction; never faked) | P6 |
| FR-27 | Manager approval flow for pending payments per permissions | P6 |
| FR-28 | AI natural-language queries grounded in real data, role-filtered | P7 |
| FR-29 | AI actions require explicit confirmation; AI never bypasses rules | P7 |
| FR-30 | Plans & entitlements cached offline with grace period; never block core | P8 |

## 8. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Core operations fully offline | 100% of P1–P4 features with airplane mode on |
| NFR-02 | Startup time on budget hardware (2GB RAM Android) | < 2.5 s to usable dashboard |
| NFR-03 | Memory (Windows app, 4GB laptop) | < 300 MB steady state |
| NFR-04 | Record payment flow | ≤ 5 taps / ≤ 15 s for a known tenant |
| NFR-05 | Data integrity | No silent loss or overwrite of financial records — enforced in DB + services + tests |
| NFR-06 | Sync convergence | Any two authorized devices converge deterministically; duplicate payments impossible |
| NFR-07 | Organization isolation | Server-side enforcement (RLS); tested |
| NFR-08 | Local data at rest | SQLite encrypted (SQLCipher) in app shells; keys in OS keystore |
| NFR-09 | Recoverability | Device loss recoverable via encrypted backup (offline) or cloud account (online) |
| NFR-10 | Understandability | No raw technical errors in UI; Kenyan English + Kiswahili-ready labels |
| NFR-11 | Battery/data | No background network chatter; sync is user-triggered or on-connect |
| NFR-12 | Small install | Android APK < 40 MB; Windows installer < 150 MB |

## 9. Acceptance — the "Green View" end-to-end scenario

The finished local product (end of M5) must pass, **without internet for 3 days**:
caretaker registers 2 tenants, records 5 payments (one partial, one with M-Pesa ref),
reports 2 maintenance issues; landlord records an expense on the laptop; then devices
sync over local Wi-Fi with zero duplicates, zero lost tenants, zero overwritten history;
later cloud sync (M5+) uploads everything and a fresh install restores the organization.
This scenario is an automated integration test (see `ROADMAP.md`).

## 10. Pricing philosophy (v2, not hard-coded)

Free tier for small landlords (enough for Landlord C); paid tiers for scale (units,
users, cloud features, AI). Offline users keep full core function regardless of plan
state; entitlements are cached locally with a generous grace period. No pricing is
hard-coded in the product; the commercial engine reads plan configuration.
