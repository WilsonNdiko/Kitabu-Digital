# Apps (Milestone 3)

M3 builds the application shells on top of the shared core
(`@kitabu/core`) — the same services, triggers and audit trail that the tests
exercise run unchanged inside every shell.

## Delivered so far (M3)

| App | Path | What it is |
|---|---|---|
| **Web shell** | `apps/web` | The screens — React + Vite. This is the UI that the Electron renderer will host; it runs in a browser today for development and demos. |
| **Local API** | `apps/local-api` | The app backend — a **zero-dependency** `node:http` server that opens the real file-backed SQLite database and routes JSON to the core. Stands in for the Electron main process (IPC) and enforces the acting-user (`X-Acting-User`) per request. |

Screens implemented (per `docs/UX.md`): onboarding, dashboard (collection,
arrears, month overview, activity), properties + houses, tenants (search, detail
with statement & history), record payment (≤5-tap flow, amount prefilled),
payments with the M-Pesa **verification queue**, receipts (list, printable
detail with integrity + digest, void/reissue), settings (organization, team &
roles, **backup & restore**, device, demo reset).

Role enforcement is **in the core, not the UI** (`packages/core/test/roles.test.ts`):
caretakers register tenants and record payments; only the owner verifies codes,
issues receipts, places tenants and changes rent (`docs/SECURITY.md` §3).

## Local encrypted backup (FR-22 / NFR-09)

Settings → **Backup & restore** (owner-only). One file holds the whole books —
houses, tenants, payments, receipts, signatures, audit trail — encrypted with
**AES-256-GCM**; the key is derived from the passphrase with **Argon2id**
(OWASP defaults: 19 MiB, 2 passes — ~1 s). Both algorithms are vendored in
`packages/core/src/foundation/` (zero dependencies) and validated against the
official RFC 7693 / RFC 9106 test vectors.

- `POST /api/backup/export` `{passphrase}` → octet-stream
  `kitabu-backup-YYYY-MM-DD.kitabu`. The passphrase is never stored.
- `POST /api/backup/restore` `{passphrase, backupBase64}` → the passphrase is
  verified and the snapshot fully validated **before** the current database is
  replaced — a wrong passphrase never destroys existing data.
- Snapshot semantics per `docs/SYNC.md` §6: all live rows of the 17 synced
  tables + schema version; `app_settings`/`change_log` stay local-only; the
  restored device adopts the snapshot's device identity. Receipt signatures
  verify on the restored device (proven in tests + the HTTP walkthrough).
- Archive format and KDF parameters live in the file header
  (`packages/core/src/services/backup.ts`), so future cost increases keep old
  backups readable.

## Running

```bash
npm install
npm run dev     # local API (127.0.0.1:8787, demo-seeded SQLite) + Vite (0.0.0.0:5173)
npm run demo    # production-style single process: API serves the built SPA on :8787
```

- The demo database is seeded on first run (`KITABU_SEED=0` disables) with a
  believable Green View portfolio: a model tenant, a partial payment waiting for
  M-Pesa verification, an arrears case, and a new tenant in advance.
- `apps/local-api/data/` is git-ignored — it is this device's book.

## Planned next (rest of M3)

| App | Path (planned) | Stack | SQLite adapter |
|---|---|---|---|
| Windows | `apps/desktop` | Electron hosting the web shell | better-sqlite3 (+ SQLCipher build), DPAPI-sealed key |
| Android | `apps/mobile` | React Native (Expo dev-client) | react-native-quick-sqlite / op-sqlite (+ SQLCipher) |

Plus: PIN/biometric unlock and the receipt PDF template (the signed, frozen
snapshot it renders — and the encrypted backup that carries it — are already in
the core).
