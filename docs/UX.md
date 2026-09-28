# Kitabu Digital — UX Architecture

## 1. Feel

A **digital notebook**, not a dashboard product. Big touch targets, few fields, Kenyan vocabulary (House, Caretaker, KSh, M-Pesa), instant offline response. One responsive UI: bottom tab bar on phones, side rail on desktop.

## 2. Navigation

```
Home        – dashboard + quick actions
Properties  – properties → houses (units) → occupancy
Tenants     – register, search, tenant profile + statement
Payments    – record payment (hero flow), payment list, verification queue
More        – Receipts, Expenses, Maintenance, Reports, Sync, Devices, Staff, Settings, Backup
```

Global: search bar (tenant/phone/house/reference/receipt no — offline), sync status chip (`● Offline` / `↻ 3 waiting` / `✓ Synced`), current property filter.

## 3. Screens

- **Onboarding (first run, no account needed):** Karibu → your name + PIN → organization (business) name → first property → houses (quick bulk add: "10 houses at KSh 8,500") → done. Under 2 minutes. "Create cloud account" is offered, skippable, never nagging.
- **Home:** This month: Expected / Collected / Outstanding; tenant chips Paid n · Partial n · Overdue n; open maintenance count; quick actions `+ Record Payment` `+ Add Tenant` `+ Expense` `+ Maintenance`. No graphs.
- **Record Payment (the hero flow):** pick tenant (search, recent first) → house & balance shown automatically → amount (prefilled with balance) → method → reference if M-Pesa/bank → save → status shown honestly (VERIFIED or PENDING VERIFICATION) → `View receipt` when verified. Nothing already known is asked again.
- **Tenant profile:** balance headline, tenancy (house, rent, since), statement (running balance), payments, documents, move/end tenancy.
- **Arrears:** per property/month; rows like `A-12 · John Kamau · Rent 12,000 · Paid 8,000 · Balance 4,000 · PARTIAL`; filter by property/month/amount; WhatsApp-friendly reminder text copy button (Phase 3+).
- **Receipt:** clean printable/PDF layout with property name, receipt no, tenant, house, amounts, previous/remaining balance, method+reference, period, signature image. Share via WhatsApp/print/save.
- **Verification queue (manager/owner):** pending payments with reference, recorder, date; Verify/Reject with reason.
- **Sync:** local changes waiting, nearby paired devices, cloud status, last syncs, `Sync Now`, `Add Device` (QR).
- **Errors:** always plain language + what to do next. Technical detail never shown.

## 4. UX rules

1. Common actions ≤ 2 taps from Home.
2. Never re-ask known information.
3. Every save confirms visibly, with local-vs-synced honesty.
4. Optional fields stay collapsed ("Add more details ▾").
5. Empty states teach ("No tenants yet — add your first tenant").
6. Works one-handed on a 5" phone; readable in sunlight (high contrast).
