# Apps (Milestone 3)

M3 builds the application shells on top of the shared core
(`@kitabu/core`) — the same services, triggers and audit trail that the tests
exercise run unchanged inside every shell.

## Delivered so far (M3, first slice)

| App | Path | What it is |
|---|---|---|
| **Web shell** | `apps/web` | The screens — React + Vite. This is the UI that the Electron renderer will host; it runs in a browser today for development and demos. |
| **Local API** | `apps/local-api` | The app backend — a **zero-dependency** `node:http` server that opens the real file-backed SQLite database and routes JSON to the core. Stands in for the Electron main process (IPC) and enforces the acting-user (`X-Acting-User`) per request. |

Screens implemented (per `docs/UX.md`): onboarding, dashboard (collection,
arrears, month overview, activity), properties + houses, tenants (search, detail
with statement & history), record payment (≤5-tap flow, amount prefilled),
payments with the M-Pesa **verification queue**, receipts (list, printable
detail with integrity + digest, void/reissue), settings (organization, team &
roles, device, demo reset).

Role enforcement is **in the core, not the UI** (`packages/core/test/roles.test.ts`):
caretakers register tenants and record payments; only the owner verifies codes,
issues receipts, places tenants and changes rent (`docs/SECURITY.md` §3).

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

Plus: PIN/biometric unlock, encrypted backup export/restore (Argon2id), and the
receipt PDF template (the signed, frozen snapshot it renders is already in the core).
