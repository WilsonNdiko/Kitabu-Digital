# UX Architecture

> The app must feel like a **digital notebook**, not enterprise software. Kenyan English
> by default, Kiswahili-ready labels (i18n from M3). Terminology is configurable per
> organization (default: **House**; alternatives: Unit, Room, Apartment).

## 1. Navigation structure

**Mobile (Android): bottom tabs + FAB**

```
┌───────────────────────────────────────┐
│  [Screen content]         [● Offline] │   ← persistent sync chip
│                                       │
│                 ( + )                 │   ← FAB: Record Payment (primary action)
│                                       │
│  Home | Tenants | Payments |  More    │
└───────────────────────────────────────┘
```

**Windows: left rail**

```
Home · Properties · Tenants · Payments · Receipts · Expenses · Maintenance ·
Reports · Devices & Sync · Settings
```

"More" (mobile) contains: Properties, Receipts, Expenses, Maintenance, Reports,
Devices & Sync, Settings, AI Assistant (when available).

## 2. Screen map (screen-by-screen)

| # | Screen | Purpose | Key elements |
|---|---|---|---|
| 1 | **Onboarding** | First run | Language, org name + landlord name, PIN setup, "Works offline" explainer, optional "Create cloud account later" |
| 2 | **Home / Dashboard** | Answer "how are my properties doing?" in seconds | Cards: Properties (n, houses, occupied, vacant) · This Month (expected/collected/outstanding) · Tenants (paid/partial/overdue counts) · Maintenance (open) · Offline chip · quick actions |
| 3 | **Properties list** | All properties | Cards with occupancy + collection rate; + Add Property |
| 4 | **Property detail** | One property | Tabs: Houses · Tenants · This Month · Expenses · Maintenance; + Add House |
| 5 | **House list/detail** | Units of a property | Status chips (vacant/occupied/maintenance); house detail = current tenant, rent, balance, history timeline |
| 6 | **Tenants list** | Find a tenant | Search-first (name/phone/house); arrears chips; archived toggle |
| 7 | **Tenant detail** | One tenant | Contact, current + past houses, balance, statement, payments, documents; actions: record payment, move, end tenancy |
| 8 | **Add tenant** | Fast onboarding | Required: name, phone, house, rent. Optional: deposit, ID, alt phone, move-in date, notes. House picker shows only vacant houses |
| 9 | **Record payment** | The most-used flow | Tenant → (house auto-filled) → amount (default = balance or rent) → method → reference (if M-Pesa) → save → receipt |
| 10 | **Payments list** | History + verification | Filters (property/month/status/method); pending-verification queue; badge for PENDING |
| 11 | **Payment detail** | Audit view | Status timeline, verifier, reversal/adjustment actions (permission-gated) |
| 12 | **Receipts list** | Issued receipts | Search by number; void marker |
| 13 | **Receipt detail / PDF** | The receipt | Preview, share (WhatsApp/print), QR verify |
| 14 | **Arrears** | Who owes what | Rows per tenancy: house, tenant, rent/paid/balance, status; filters property/building/month/amount; totals |
| 15 | **Expenses list + add** | Money out | Category chips (Kenyan categories), amount, property, date, attachment |
| 16 | **Maintenance list + detail + report** | Issues workflow | Status pipeline reported→assigned→in-progress→completed; photos; cost |
| 17 | **Reports** | Trust in numbers | Rent collection, tenant statement, expenses, occupancy, payment history; export PDF/CSV; date/property pickers |
| 18 | **Global search** | One search box everywhere | Searches tenants, phones, houses, refs, receipt numbers, expenses, maintenance; works fully offline |
| 19 | **Devices & Sync** | Control sync | Nearby devices (available/last seen), cloud status, local pending count, Sync Now, per-device last sync, Add Device (QR), Revoke |
| 20 | **Pairing screen** | Add a device | Big QR + 5-min countdown; success/failure states |
| 21 | **Backup** | Safety | Last local backup time, auto-backup toggle, backup now, restore from file (passphrase), export |
| 22 | **Settings — organization** | Names, PIN, KRA PIN, terminology (House/Unit/Room/Apartment), signatures manager |
| 23 | **Settings — team & roles** | Users | Add manager/caretaker, permissions toggles, per-property assignment |
| 24 | **Cloud account (optional)** | Sign in / link | Clear benefits list; "Later" is always fine; local→cloud migration progress screen |
| 25 | **Unlock** | App lock | PIN / biometric; lockout countdown |
| 26 | **AI assistant** (M8) | Ask & act | Chat sheet; confirmation cards for proposals |
| 27 | **Conflict review** (M5) | Owner resolves sync conflicts | Side-by-side, keep-mine/take-theirs |
| 28 | **Verification queue** (M6) | Pending M-Pesa codes | Verify now (online), reject with reason |

## 3. The payment flow (target: ≤5 taps)

```
FAB (+)                      1
 → tenant search (2–3 chars, tap)   2
 → amount prefilled with balance/rent (accept or edit)   3
 → method chips: [Cash] [M-Pesa] [Bank] (tap)   4
 → (M-Pesa) ref field auto-focused, numeric-ish keyboard   —
 → Save                      5
 → "Saved ✓ on this phone — not yet synced" + receipt preview/share
```

Rules: never re-ask what the system already knows (house, rent, tenant phone);
sensible defaults everywhere; after save, the receipt is one tap away (cash/verified)
or clearly pending (unverified M-Pesa).

## 4. Offline & sync communication (brief §54–55)

- Persistent chip top-right: `✓ All synced` · `↻ 3 changes waiting` · `● Offline`
  (tap → Devices & Sync screen).
- Every save toast distinguishes: **"Saved on this phone"** vs "Saved and synced".
- Sync screen (per brief): local pending count, nearby devices with availability,
  cloud connection state + last sync, and **Sync Now**.
- Destructive/rare actions (reversal, void receipt, revoke device) always confirm with
  plain-language consequences.

## 5. Error messages (brief §53)

Translate every technical failure to landlordeze, e.g.:

| Technical reality | User sees |
|---|---|
| FK constraint on tenancy insert | "This house already has a tenant. End their tenancy first." |
| Unique payment reference | "This M-Pesa code has already been recorded. Check today's payments." |
| Unique unit label | "You already have a house called A-12 in this property." |
| DB busy / disk full | "The phone's storage is full — Kitabu couldn't save. Free space and try again." |
| Sync batch failure | "Sync didn't finish. Nothing was lost — your changes are safe on this phone. Try again." |

Developer detail goes to a local structured log (never to UI), exportable in
Settings → Support (opt-in).

## 6. Design language

- Large text, high contrast, thumb-reach actions (budget phones, bright sun).
- Money always `KSh 12,500` formatting; phone numbers `0712 345 678`.
- Dates Kenyan style (`14 Sep 2026`), weeks start Monday, rental month = calendar
  month (org timezone).
- Colors: trust-blue primary, status colors (paid=green, partial=amber,
  overdue=red, vacant=gray). Iconography minimal. No decorative graphs on Home
  (brief §38: avoid unnecessary graphs).
