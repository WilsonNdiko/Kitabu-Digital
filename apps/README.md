# Apps (Milestone 3)

The application shells are intentionally **not built yet** — Milestones 1–2 build and
harden the shared core (`packages/core`) first, per the roadmap
([docs/ROADMAP.md](../docs/ROADMAP.md)) and the brief's rule: *build the deterministic
foundation first*.

Planned shells, both consuming `@kitabu/core` via its `SqlitePort`:

| App | Path (planned) | Stack | SQLite adapter |
|---|---|---|---|
| Android | `apps/mobile` | React Native (Expo dev-client) | react-native-quick-sqlite / op-sqlite (+ SQLCipher) |
| Windows | `apps/desktop` | Electron + React | better-sqlite3 (+ SQLCipher build) |

The core is shell-agnostic today: it runs headless under Node in CI
(`npm test`) and will run unchanged inside both shells.
