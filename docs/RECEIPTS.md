# Receipt Architecture

> Receipts are the product's promise to the tenant and the landlord's legal record.
> They are **assembled automatically from system data**, **immutable once issued**, and
> **tamper-evident** (brief §18–19).

## 1. Assembly — no re-typing

```
Receipt = f(tenancy, tenant, unit, property, organization, payment, balances, signature)
```

The issuer never enters amounts, names, house numbers or balances — the receipt service
reads them transactionally at issuance and **freezes them into `snapshot_json`**. Later
changes (tenant renamed, rent changed, property renamed) never alter an issued receipt.

## 2. Numbering — unique offline, per organization

- Sequence space is **per organization**, allocated to devices in **reserved blocks**
  (`receipt_number_blocks`: org creation reserves block 1–500 for the first device;
  each pairing grants the next block; the cloud grants more on request).
- Display format: `R-000123` (zero-padded, per-org ascending within a device's blocks).
- Devices warn owners at 80% block usage (next sync refills). Because blocks are
  disjoint, two offline devices can never issue the same number; the
  `UNIQUE(org_id, receipt_no)` index is the backstop (violation → conflict queue, by
  construction unreachable when the protocol is followed).
- Numbers are never re-used, even if a receipt is voided.

## 3. Immutability & corrections

- `receipts` rows are INSERT-only. SQLite triggers forbid UPDATE except the whitelisted
  void columns (`voided_at`, `void_reason`) and sync metadata; DELETE is forbidden.
- Errors are fixed by **void + reissue**: the wrong receipt is marked void (reason,
  actor, timestamp — audited) and a new receipt with a **new number** references it
  (`supersedes` in snapshot). The PDF of a voided receipt prints "VOID — replaced by
  R-000452". History remains fully visible.
- A receipt is issued only for a `VERIFIED` payment (or immediately for
  owner/permissioned cash — the same event that verifies). `PENDING` M-Pesa payments
  show "Receipt available after verification".

## 4. Digital signatures — per landlord/property, history-safe

- `signature_images`: per-organization default and optional per-property overrides
  (`property_id NULL` = org default). Selected at issuance: property-specific first,
  org default fallback.
- The **image used is frozen into the receipt** (`signature_image_id` +
  `signature_digest`), so replacing a signature later never changes old receipts.
- Signature lifecycle: upload (image, cropped in-app) → activate (`active_from`) →
  replace (`active_to` on the old one) — all audited; images are content-addressed
  documents (sha256) and sync like any other document.
- Optionally the landlord can also keep a **drawn/biometric** signature or
  name-printed styling; the receipt displays the image in a fixed block ("Authorized
  signature: ______________").

## 5. Tamper-evidence (works offline)

At issuance the service computes:
- `digest = SHA-256(canonical_json(snapshot))` — canonical JSON = sorted keys, UTF-8,
  no whitespace.
- `crypto_signature = Ed25519.Sign(org_receipt_key, digest)` — the org receipt key pair
  is generated at organization creation, private key wrapped with the device/keystore
  and shared to paired devices via the pairing channel (and to the cloud when linked).

Every receipt PDF carries a QR with `{orgId, receiptNo, digest, sig}`. Any authorized
device can verify a printed receipt **offline** (recompute digest from the stored
snapshot; check the Ed25519 signature). A public verification page (cloud, M6+) lets
tenants verify by scanning — no app needed.

## 6. PDF layout (spec for M2 implementation)

```
┌──────────────────────────────────────────────┐
│  [Org name]              RECEIPT  R-000123   │
│  [Property name], [town/estate]              │
│  ──────────────────────────────────────────  │
│  Received with thanks:  [Tenant name]        │
│  House: [A-12]   Date: [14 Sep 2026]         │
│  For: Rent [September 2026]                  │
│                                              │
│  Previous balance      KSh        4,000      │
│  Amount paid           KSh       12,000      │
│  Remaining balance     KSh         0    ✓    │
│  Method: M-Pesa (QGH7XJ2M9L)                 │
│                                              │
│  _______________         ┌─────────┐         │
│  [Signature image]       │ QR code │         │
│  Authorized signature    └─────────┘         │
│  Issued by [name] · [app] · [device]         │
└──────────────────────────────────────────────┘
```

Amounts also in words ("Kenya Shillings Twelve Thousand Only"). Generation:
`pdfkit` (Electron) / `react-native-html-to-pdf` or `@shopify/react-native-pdf`
generation from one shared HTML/JSON template (single source for both platforms —
template lives in core, rendering in shells). Share intent: WhatsApp, print, save.

## 7. Tests (M2)

- Numbering: block allocation, no reuse, void keeps number, concurrent devices →
  disjoint numbers.
- Immutability: trigger rejects edits (raw SQL attempt raises); void+reissue flow
  preserves both PDFs' data.
- Snapshots: rename tenant/property post-issuance → stored snapshot unchanged.
- Digest/signature: canonicalization stability (key order, unicode names like
  "Wanjĩku"), offline QR verification succeeds; tampered snapshot fails verification.
