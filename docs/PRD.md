# Kitabu Digital — Product Requirements Document

## 1. Vision

**"All my landlord books in one simple application."**

Kenyan landlords manage rentals with exercise books, rent books, receipt books, tenant registers, Excel, WhatsApp and memory. Kitabu Digital digitizes exactly those workflows — a digital notebook, not an enterprise ERP.

## 2. What Kitabu is — and is not

| Kitabu IS | Kitabu IS NOT |
|---|---|
| A record of tenants, houses, rent, payments, expenses, maintenance | A payment processor |
| A rent ledger with arrears at a glance | An accounting suite |
| A digital receipt book with signatures | A tenant-facing portal (v1) |
| Offline-first, works with zero internet | A cloud-dependent SaaS dashboard |

**Critical rule: Kitabu never moves money.** A tenant pays the landlord directly — M-Pesa to the landlord's number/till, cash in hand, or bank deposit. The landlord/manager/caretaker then **records** that payment in Kitabu. Kitabu tracks verification status, posts the payment to the ledger, and generates the receipt. There is no STK push, no pay-through-app, no wallet.

## 3. Target users

| Persona | Portfolio | Devices | Needs |
|---|---|---|---|
| **Landlord A** | 1 apartment block, 20 units, 1 caretaker | Android phone | Simple rent book, receipts, arrears list |
| **Landlord B** | 4 properties, 120 units, 5 managers | Windows laptop + phone | Multi-property view, staff roles, reports |
| **Landlord C** | Standalone houses, 15 tenants, self-managed | Budget Android | The absolute basics, fast |

The UI must never make Landlord C feel like they are using Landlord B's software.

## 4. Functional requirements (summary)

### Must have (Phases 1–4)
- F1. Organization setup with configurable terminology (House/Unit/Room).
- F2. Properties → buildings (optional) → units.
- F3. Tenant register: minimal required fields (name + phone); everything else optional.
- F4. Tenancies: a tenant occupies a unit for a period; moves preserve history.
- F5. Rent ledger: charges + payments + adjustments + credits + reversals = balance. Never `rent - lastPayment`.
- F6. Record payments: M-Pesa (reference), cash, bank, other. Duplicate references rejected.
- F7. Payment states: PENDING → VERIFYING → VERIFIED / REJECTED; VERIFIED → REVERSED. No arbitrary transitions.
- F8. Digital receipts: auto-assembled, numbered, immutable, PDF/printable, signed with the property's signature.
- F9. Arrears view: who owes what, per property/month, at a glance.
- F10. Expenses with categories; maintenance workflow (Reported → Assigned → In Progress → Completed).
- F11. Offline everything above; local backup (encrypted export/restore).
- F12. Device-to-device sync over local Wi-Fi with QR pairing — no internet.
- F13. Powerful offline search (tenant, phone, house, reference, receipt no).
- F14. Audit log of every important action.
- F15. Roles: Owner, Manager (per-property), Caretaker (restricted; no financial reports by default).

### Should have (Phases 5–7)
- F16. Optional cloud account; local → cloud migration without duplicates; multi-device cloud sync; cloud backup; device recovery.
- F17. M-Pesa verification assistance (statement import / Daraja transaction status query against the landlord's own paybill/till) — verification only, never payment initiation.
- F18. Reports: rent collection, tenant statement, expenses, occupancy, payment history; export PDF/CSV.
- F19. AI assistant: natural-language queries over local structured data; confirmed actions via tools.

### Later (Phase 8)
- F20. Subscriptions/plans with offline entitlement caching and grace periods.

## 5. Non-functional requirements

- **Offline:** every core operation works with zero connectivity, indefinitely.
- **Performance:** usable on 4 GB RAM Windows laptops and budget Android phones; startup < 3 s; searches < 200 ms on 10k records.
- **Integrity:** financial writes are transactional; verified payments and issued receipts are immutable.
- **Isolation:** organization data separation enforced at database, API, sync and storage layers.
- **Simplicity:** a non-technical landlord can record a payment and produce a receipt in under 30 seconds.
- **Language/context:** KSh, Kenyan phone formats (07xx/01xx/+254), M-Pesa vocabulary, caretaker/manager roles, Kenyan-friendly copy ("Karibu", "House", "Rent book").

## 6. Success scenario (acceptance)

The scenario in the project brief (§64): Green View Apartments, 30 units, caretaker Jane; three days with no internet; tenants registered, payments (full/partial/M-Pesa ref) recorded, maintenance reported, expense recorded on the laptop — all offline; then local sync converges landlord + caretaker devices with no duplicates and no lost history; later, cloud sync and restore onto a new laptop reproduces the full organization.

## 7. Out of scope (v1)

- Payment initiation/processing of any kind (permanently out of scope by design).
- Tenant-facing app.
- Lease e-signing ceremonies (documents can be attached; signature = landlord receipt signature).
- iOS (architecture must not preclude it).
