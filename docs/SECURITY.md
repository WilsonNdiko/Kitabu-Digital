# Kitabu Digital — Security Architecture

## 1. Threat model (pragmatic)

Protect against: lost/stolen devices, snooping caretakers exceeding their role, one landlord reaching another's data, network eavesdropping during sync, tampered financial history. Not in scope: nation-state attackers.

## 2. Local security

- **App PIN** (per user profile on the device) gates the app; PINs stored as salted hashes (scrypt). PIN ≠ cloud password.
- Data at rest: Android file-based encryption + optional SQLCipher; Windows DPAPI-protected key + optional SQLCipher. Signature images and documents stored under app-private storage; signature files referenced by sha256 so tampering is detectable.
- **Local backups are always encrypted** (age/AES-GCM with a passphrase the landlord sets); a lost unencrypted backup file must not expose tenant data.
  - *Implemented:* `KITABU01` file format = magic ‖ scrypt salt(16) ‖ GCM iv(12) ‖ auth tag(16) ‖ AES-256-GCM ciphertext of the whole SQLite file. Restore only works on a fresh install and replays history through the sync engine (restore = local join), so the restored machine becomes a new device with its own receipt book and later syncs cannot duplicate records. The audit log is device-local and is not carried across restores (by design, v1).

## 3. Roles & permissions (RBAC)

| Capability | Owner | Manager (assigned properties) | Caretaker (assigned) |
|---|---|---|---|
| Manage org, staff, devices, signatures, backups | ✔ | ✖ | ✖ |
| Create/edit properties & units | ✔ | ✔ | ✖ |
| Register tenants / move-in | ✔ | ✔ | ✔ |
| Record payments | ✔ | ✔ | ✔ (recorded as PENDING) |
| Verify/approve/reject payments | ✔ | ✔ | ✖ |
| Reverse payments / adjustments | ✔ | ✔ (configurable) | ✖ |
| Issue receipts | ✔ | ✔ | configurable |
| View financial reports / arrears totals | ✔ | assigned only | ✖ (sees own recorded payments only) |
| Expenses / maintenance | ✔ | ✔ | report + view assigned |

Permissions are enforced in **application services** (and cloud API), never only in the UI. Caretakers never see org-wide financials by default; grants are configurable by the owner.

## 4. Device trust

- Every install = a `device` entity with a locally generated keypair; the public key is registered at pairing (QR ceremony, § docs/SYNC.md) or cloud device authorization.
- Owner can list, rename, and **revoke** devices; revocation propagates via sync and cloud, and peers verify status before every session. A revoked device cannot open new sync sessions (local or cloud); its stale local copy is inert.
- Local sync transport: mutually authenticated, encrypted channel (device keys); pairing tokens are single-use and short-lived.

## 5. Cloud security

- Auth: email/phone + password (argon2id) with optional TOTP; short-lived access tokens + rotating refresh tokens bound to the device record.
- **Organization isolation:** PostgreSQL row-level security keyed on `organization_id` from the session — enforced beneath application code; object storage prefixed per org with scoped signed URLs; sync endpoints validate that a device only ever reads/writes its own org's changes. Cross-org access is structurally impossible, not just filtered.
- Every server operation re-checks authorization; the client is untrusted by definition.

## 6. Integrity & audit

- Financial mutations only via domain services inside transactions; state machine transitions validated in `@kitabu/core`.
- `audit_log`: actor, device, org, action, entity, before/after, timestamp — appended in the same transaction as the action; synced like other data; visible to the owner.
- Issued receipts are immutable snapshots (verified by content hash); verified payments cannot be edited, only reversed with reason.

## 7. Tenant privacy

Minimal collection (name + phone suffice), role-scoped visibility (caretakers see contact info, not financial totals), audit trail on access-sensitive actions, documented retention/anonymization workflow for legal erasure requests that preserves ledger integrity (amounts stay, identity anonymized).

## 8. Error handling policy

Users see plain-language messages ("This M-Pesa code was already used on a payment for John Kamau on 14 Sep."); technical detail goes to structured local logs (rotated, PII-scrubbed) used for support diagnostics.
