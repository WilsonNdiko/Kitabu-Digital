# Kitabu Digital — Database Design

Local engine: **SQLite** (WAL, `foreign_keys=ON`). Cloud engine: PostgreSQL with the same logical schema + row-level security. Authoritative DDL: `apps/server/src/db/schema.sql`.

## 1. Identifiers

Prefixed ULIDs generated on-device: `org_…, usr_…, prop_…, bld_…, unit_…, ten_…, tcy_…, pay_…, led_…, rcp_…, exp_…, mnt_…, doc_…, dev_…, chg_…, aud_…`.
- ULID = 48-bit timestamp + 80-bit randomness → sortable, globally unique, offline-safe.
- **Deterministic ids for idempotent facts:** monthly rent charges use `led_` + hash(tenancy_id, period), so any device generating "March 2026 charge for tenancy X" produces the same id — duplicate generation is structurally impossible.

## 2. Sync metadata (every synced table)

```
org_id            TEXT NOT NULL      -- isolation key, on every row
version           INTEGER NOT NULL   -- per-row optimistic version, bumps on write
updated_at        TEXT NOT NULL      -- ISO-8601 UTC
deleted_at        TEXT NULL          -- soft delete only; financial rows are never deleted
origin_device_id  TEXT NOT NULL      -- device that created the row
```

`change_log` is appended in the same transaction as every write (see docs/SYNC.md).

## 3. Entities

```
organizations   id, name, terminology(house|unit|room), currency('KES'), settings_json
users           id, org…, full_name, phone, role(OWNER|MANAGER|CARETAKER), pin_hash, status
user_property_access   user_id, property_id      -- managers/caretakers scoped to properties
properties      id, org…, name, location, notes
buildings       id, property_id, name            -- optional level; small landlords skip it
units           id, property_id, building_id?, label, monthly_rent_minor, deposit_minor, status(VACANT|OCCUPIED|MAINTENANCE)
tenants         id, org…, full_name, phone, alt_phone?, id_number?, email?, emergency_*?, notes?
tenancies       id, tenant_id, unit_id, rent_minor, deposit_minor, start_date, end_date?, expected_pay_day, status(ACTIVE|ENDED)
rent_rates      id, tenancy_id, rent_minor, effective_from   -- historical rent (rule: rent changes preserve history)
ledger_entries  id, org…, tenancy_id, entry_type, amount_minor, period?, effective_date,
                payment_id?, reverses_entry_id?, memo, created_by
payments        id, org…, tenancy_id, tenant_id, unit_id, property_id, amount_minor,
                method(MPESA|CASH|BANK|OTHER), reference?, payer_name?, payment_date,
                status(PENDING|VERIFYING|VERIFIED|REJECTED|REVERSED),
                recorded_by, verified_by?, verified_at?, rejected_reason?, notes?
receipts        id, org…, receipt_no UNIQUE, payment_id UNIQUE, issued_at, issued_by,
                snapshot_json      -- full immutable snapshot incl. signature ref at issuance
signatures      id, org…, property_id?, image_path, sha256, active, created_at
expenses        id, org…, property_id, category, amount_minor, method, reference?, expense_date, description, recorded_by
maintenance_requests  id, org…, property_id, unit_id?, tenant_id?, title, description,
                priority(LOW|MEDIUM|HIGH), status(REPORTED|ASSIGNED|IN_PROGRESS|COMPLETED),
                assigned_to?, cost_minor?, reported_at, completed_at?
documents       id, org…, entity_type, entity_id, file_name, mime, size, sha256, storage_path
devices         id, org…, name, platform, public_key, device_code, status(ACTIVE|REVOKED), paired_at, last_sync_at
audit_log       id, org…, actor_user_id, device_id, action, entity_type, entity_id, before_json?, after_json?, at
change_log      seq (local autoincrement), change_id UNIQUE, org_id, entity_type, entity_id,
                op(UPSERT|DELETE), payload_json, hlc, origin_device_id, synced_to_cloud, created_at
sync_peers      device_id, last_seq_received      -- per-peer sync cursor
```

### Key constraints & indexes

- `UNIQUE(org_id, method, reference) WHERE reference IS NOT NULL` on `payments` → **duplicate M-Pesa/bank references rejected at the engine level**, not just the UI.
- `UNIQUE(payment_id)` on `receipts` → one receipt per payment.
- Partial index: one ACTIVE tenancy per unit (`UNIQUE(unit_id) WHERE status='ACTIVE'`).
- `UNIQUE(tenancy_id, period)` on rent CHARGE entries (backed by deterministic ids).
- Indexes on: `tenancies(tenant_id)`, `tenancies(unit_id)`, `ledger_entries(tenancy_id)`, `payments(tenancy_id)`, `payments(reference)`, `payments(payment_date)`, `change_log(synced_to_cloud)`, all `*(org_id)`.

## 4. The financial ledger (design)

**Balance is never `rent − lastPayment`.** All financial activity is append-only `ledger_entries`:

| entry_type | Sign convention (amount_minor) | Meaning |
|---|---|---|
| `CHARGE` | + (debit) | Monthly rent due (one per tenancy per period, deterministic id) |
| `PAYMENT` | − (credit) | Posted when a payment reaches VERIFIED |
| `ADJUSTMENT` | + or − | Correction with mandatory memo (e.g. waived late amount) |
| `CREDIT` | − | Goodwill/deposit application |
| `REVERSAL` | negates target | Points to `reverses_entry_id`; used when a payment is reversed |

```
balance(tenancy) = Σ amount_minor          -- positive ⇒ tenant owes; negative ⇒ advance/credit
```

- **Partial payment:** CHARGE +12 000, PAYMENT −8 000 ⇒ balance 4 000 (status PARTIAL).
- **Advance rent:** payments exceeding charges leave a negative balance consumed by future charges.
- **Rent change:** new row in `rent_rates` with `effective_from`; future charges use the rate effective for that period; history untouched.
- **Reversal:** verified payment → status REVERSED **plus** a REVERSAL ledger entry negating the PAYMENT entry. Original rows remain, with actor/when/reason in the entry memo and audit log.
- **Statements** are the ordered ledger with a running balance — reproducible for any point in time.
- Money is stored as **integer minor units** (cents of KES). No floats, ever. Display: `KSh 12,000`.

### Payment state machine

```
            record (M-Pesa ref / caretaker cash)
   ┌────────┐   verify-start   ┌───────────┐  confirm  ┌──────────┐  reverse  ┌──────────┐
   │ PENDING│ ───────────────► │ VERIFYING │ ────────► │ VERIFIED │ ────────► │ REVERSED │
   └───┬────┘                  └─────┬─────┘           └──────────┘           └──────────┘
       │  owner/manager cash: recorded directly as VERIFIED
       └──────────► REJECTED  ◄──────┘ (with reason)
```

Only these transitions exist; they are enforced in `@kitabu/core` (`assertPaymentTransition`) and services — never from the UI. The PAYMENT ledger entry is posted exactly when the payment enters VERIFIED. Receipts can only be issued for VERIFIED payments and are immutable snapshots.

## 5. Receipt numbering (offline-safe)

`KD-<deviceCode>-<seq>` e.g. `KD-7F3K-000042`: `deviceCode` is unique per device, `seq` a local counter — like giving each caretaker their own physical receipt book. No coordination needed; uniqueness holds after any sync. The `snapshot_json` freezes tenant, house, amounts, balances, and the signature image hash at issuance so historical receipts always render exactly as issued.

## 6. Deletion policy

- Financial rows (`ledger_entries`, `payments`, `receipts`): **never deleted**, only state-transitioned/reversed.
- Tenants/tenancies: soft-delete (`deleted_at`) with tenancy history retained; a tenant with financial history can be archived, never purged (rule §48.7).
- Hard deletion only via explicit, audited, org-owner data-erasure workflows (privacy/legal), which anonymize rather than break ledger references.
