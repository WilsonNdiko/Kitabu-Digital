# Deployment & Operations

> Cloud components arrive in M6+; local apps in M3+. This document fixes the target
> topology and pipelines now so milestones build toward it.

## 1. Local applications (the product's default mode)

| Target | Channel | Update mechanism |
|---|---|---|
| Windows | Signed installer (electron-builder, NSIS) + portable zip | electron-updater (staged rollout, delta updates) |
| Android | Play Store (signed AAB) + direct APK download for sideloaders (common in Kenya) | Play updates + in-app APK update check for sideloaded installs |

- Code signing: Windows EV certificate; Android Play App Signing.
- Offline installs must work: first run requires **no** network (onboarding is local).
- Crash/ANR reporting: opt-in only, scrubbed (no personal/financial values).

## 2. Cloud topology (M6+)

```
                    ┌────────────┐
   Devices ──TLS──► │ CDN/WAF    │ (Cloudflare)
                    └─────┬──────┘
                          ▼
                   ┌───────────────┐     ┌──────────────┐
                   │ Kitabu API    │────►│ PostgreSQL   │
                   │ (NestJS,      │     │ (Neon/RDS,   │
                   │  containers)  │     │  RLS enabled)│
                   └───┬───────┬───┘     └──────────────┘
                       │       │
              ┌────────▼──┐ ┌──▼─────────────┐   ┌───────────────┐
              │ Redis     │ │ Worker (queues:│   │ Object store  │
              │ (rate-    │ │ mpesa verify,  │   │ (R2/S3)       │
              │  limit,   │ │ snapshots,     │   │ org/{id}/{sha}│
              │  jobs)    │ │ compaction)    │   └───────────────┘
              └───────────┘ └────────────────┘   ┌───────────────┐
                           ┌────────────────────►│ Daraja (SAF)  │
                           │  webhooks in        └───────────────┘
```

- **Environments:** `dev` (docker-compose: Postgres + Redis + API), `staging`
  (managed, sandbox keys), `production` (managed, production keys).
- **Regions:** primary in Europe/Africa edge via CDN; Kenyan latency dominated by
  mobile networks — API in a single region is acceptable for sync-sized payloads;
  revisit with real telemetry.
- **Migrations:** tracked SQL files, applied by `kitabu-api migrate` (gated: backward-
  compatible only; expand → migrate → contract).
- **Secrets:** environment-scoped (Daraja keys, JWT keys, DB creds) via platform
  secret store; never in repo; rotation runbook.
- **Observability:** pino structured logs (request ids, org ids — never payloads with
  personal data), Sentry, health endpoints (`/healthz`, `/readyz`), dashboard for
  sync lag per org (op-log tail depth).
- **Backups:** Postgres PITR + daily snapshots; `org_changes` is append-only so
  point-in-time org reconstruction is always possible; quarterly restore drills.

## 3. CI/CD (GitHub Actions)

```
on PR:      core tests (matrix: Node 22) · typecheck · lint · adapter conformance ·
            docs lint
on merge:   same + coverage gate on packages/core (financial & sync suites must be
            100% line-covered) · build Electron (win) · build Android (EAS) ·
            deploy staging
on tag:     deploy production (manual approval) · signed releases ·
            changelog + in-app update manifest
```

- The **isolation suite** (cross-org access) and the **never-fake-M-Pesa guard** run
  in the required checks for any deploy.
- Self-hosted runners not required; standard GitHub-hosted runners suffice.

## 4. Local development

```bash
npm install          # dev tooling only (typescript, @types/node)
npm test             # core test suites (no network, no services)
npm run typecheck
```

- Core tests run against in-memory SQLite via `SqlitePort` — no Docker needed.
- `docker compose up` (M6+) brings up Postgres + Redis + API for server work.
- Test databases and fixtures live in `tools/`; recorded M-Pesa fixtures are
  committed (no credentials inside, sandbox only).

## 5. Support & diagnostics

- In-app "Support export" (opt-in): app version, platform, schema version, redacted
  log tail, sync state summary — **never** tenant data or financial rows.
- Versioning: semver; schema version independent and monotonic; op protocol version
  negotiated at HELLO with one-version-backward compatibility window.
