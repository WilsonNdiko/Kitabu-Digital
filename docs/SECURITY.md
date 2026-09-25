# Security Architecture

## 1. Threat model (STRIDE summary)

| Threat | Vector | Primary mitigation |
|---|---|---|
| Cross-tenant data leak | Bugs/malice in cloud API | Server-side authorization + PostgreSQL RLS; clients never supply org ids; tested isolation suite |
| Stolen phone (caretaker) | Device theft | Encrypted local DB (SQLCipher) + app lock (PIN/biometric) + OS keystore keys + remote device revocation |
| Falsified payments (insider) | Caretaker recording fake M-Pesa codes | Verification states; codes only become VERIFIED via real provider responses; immutable audit trail; owner approval rules |
| History tampering | Direct DB edit on rooted device | SQLCipher at rest; append-only triggers; receipt digests + Ed25519 signatures (tamper-evident even offline) |
| LAN eavesdropping during local sync | Same-WiFi attacker | Pinned-key encrypted transport; pairing requires physical QR |
| Rogue device joining sync | Impersonation | Device key pairs pinned at pairing; revoked keys rejected at HELLO |
| Backup theft | Exported backup files | Backups encrypted with Argon2id-derived key from user recovery passphrase |
| Cloud credential theft | Phished/stolen tokens | Short-lived JWTs + device-key attestation binding; refresh token rotation |
| Bruteforce app PIN | Local attacker | Rate limiting with exponential lockout (5→15→60 s→…); PIN unlocks session, DB key lives in OS keystore (not derived from PIN) |

## 2. Identity & authentication

### Local (device)
- **App lock:** user PIN (≥4 digits) + optional biometric. PIN verification:
  PBKDF2-HMAC-SHA256, ≥600k iterations, 128-bit salt. Wrong-PIN lockout table
  (attempts, locked_until) persisted; exponential backoff.
- The PIN gates *use*, not *decryption*: the database key is a random 256-bit key
  sealed by the OS keystore (Android Keystore AES-GCM; Windows DPAPI
  `CryptProtectData`), released to the running session after unlock. Changing the PIN
  re-wraps only the verifier, never re-encrypts data.

### Devices (sync identity)
- Each installation generates an **Ed25519 key pair**; private key in OS keystore
  (hardware-backed where available), never leaves the device.
- Pairing (QR, physical proximity) exchanges and pins public keys → TOFU with
  out-of-band verification (the QR itself).
- Sync sessions: mutual challenge/response signatures; session keys via X25519 ECDH.

### Cloud (optional accounts)
- Sign-in: phone-number/OTP (Kenyan-first) or email+password (argon2id), plus OAuth
  (Google) later. Issues 15-minute access JWT (org memberships embedded as claims) +
  rotating refresh token bound to the device key.
- Every API call requires **JWT + device attestation** (signature over
  method/path/timestamp with the registered device key). A stolen JWT without the
  device key is useless.

## 3. Authorization

### Roles and permissions (enforced in `@kitabu/core` services — the same checks run locally and in the cloud)

| Permission | OWNER | MANAGER | CARETAKER |
|---|---|---|---|
| property.manage | ✔ | assigned properties | ✖ |
| tenant.create / tenant.edit | ✔ | ✔ | ✔ (create) |
| tenant.view_contacts | ✔ | ✔ | assigned units only |
| payment.record | ✔ | ✔ | ✔ |
| payment.record_cash_verified | ✔ | configurable | ✖ |
| payment.verify / reject | ✔ | configurable | ✖ |
| payment.reverse | ✔ | ✖ | ✖ |
| receipt.issue | ✔ | configurable | ✖ |
| finance.view_reports | ✔ | assigned properties | ✖ |
| finance.adjust | ✔ | ✖ | ✖ |
| expense.manage | ✔ | ✔ | ✖ |
| maintenance.manage | ✔ | ✔ | ✔ (report; assign: manager+) |
| devices.manage (pair/revoke) | ✔ | ✖ | ✖ |
| org.settings / signatures | ✔ | ✖ | ✖ |
| backup.manage | ✔ | ✖ | ✖ |

Notes: managers may be scoped to assigned properties (property-level assignment rows in
M6); caretakers never see org-wide financial reports (brief §8, §51). Permission checks
live in the service layer — the UI only *reflects* them; the cloud re-checks on every
request. Never trust the client.

### Multi-tenant isolation (cloud) — defense in depth

1. **API layer:** org id derived from verified JWT claims; request rejected if the
   member is not active in that org.
2. **Database layer:** PostgreSQL RLS — `USING (org_id = current_setting('app.org_id'))`
   on every tenant table; the connection sets `app.org_id` per transaction. A bug in
   the API *still* cannot cross tenants.
3. **Storage layer:** object keys prefixed `org/{orgId}/`; URLs signed only after
   membership + role check; no bucket listing to clients.
4. **Sync layer:** op streams are org-scoped (`org_changes` RLS); pull cursors are
   per-device and validated against device→org registration.
5. **Testing:** an automated isolation suite runs cross-org access attempts through
   every endpoint (positive + negative) on every release.

## 4. Data protection

| Where | Protection |
|---|---|
| Local DB at rest | SQLCipher (AES-256-CBC/HMAC); key 256-bit random, OS-keystore-sealed |
| Local DB in use | WAL mode; keys held only in process memory, zeroed on lock |
| Documents/images | Content-addressed blobs (sha256), stored in app-private storage, encrypted container on Android |
| Backups | AES-256-GCM archive; key = Argon2id(passphrase or 12-word recovery phrase, salted); passphrase never stored |
| Transport (LAN) | Pinned-cert TLS (host) or ECDH + AEAD framing (peer-to-peer) |
| Transport (cloud) | TLS 1.3 |
| Cloud at rest | Managed Postgres encryption-at-rest + object-store encryption |
| Audit log | Append-only everywhere (triggers locally, RLS + append policy in cloud) |

Tenant personal data (phones, ID numbers) is business-sensitive: collected minimally
(PRD), visible only to roles with `tenant.view_contacts`, included in synced payloads
(needed for caretaker operation) but never logged, never sent to AI providers beyond
what a query requires (AI.md), and exportable/deletable per organization
(data-export + org wipe in M6+).

## 5. Device trust lifecycle

```
pair (QR, physical) → ACTIVE → { rename, sync } → REVOKED (owner action)
```

- Registry is the synced `devices` table + (cloud) authoritative copy.
- Revocation op applies immediately everywhere via the op-log; HELLO from a revoked
  key is rejected. Revoked device keeps its local data but can no longer exchange
  ops — the owner is prompted to wipe it if recoverable.
- Lost device (offline-only org): restore last encrypted backup on a new device
  (recovery passphrase); the old device's reserved receipt block is marked lost
  (numbers simply never used).
- Lost device (cloud org): sign in on new device → verify (OTP to registered phone)
  → restore org → old device revoked from device screen.

## 6. Financial integrity controls (see FINANCIAL-LEDGER.md, RECEIPTS.md)

- Append-only ledger + triggers; explicit reversal flow with reason/actor.
- Receipt tamper-evidence: `digest = sha256(canonical snapshot JSON)`, Ed25519
  signature by org receipt key, QR on the PDF containing (org, receipt, digest, sig) —
  verifiable offline by any authorized device, online by anyone once a public verify
  page exists (M6+).
- M-Pesa verification only from provider responses (M-PESA.md) — a typed code is
  never proof.

## 7. Secure defaults & operational security

- No telemetry by default; opt-in crash diagnostics only (M9), scrubbed of personal
  and financial values.
- Dependency policy: zero runtime dependencies in the core (ADR-012); lockfiles +
  automated audit in app/server shells.
- Secrets (Daraja keys, JWT signing keys) via environment/KMS, never in the repo;
  keys rotated on schedule; webhook endpoints validate source (shared secret +
  timestamp window).
- Local dev uses fixture credentials only; production verification paths have no
  "test mode" bypass (M-PESA.md §4).
