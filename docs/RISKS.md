# Architectural Risks — Self-Challenge

> Phase 0 closing exercise (brief §66): attack our own design before building.
> Each risk has an honest assessment and a concrete mitigation, not a shrug.

## R1 — Two UI codebases (React Native + Electron) instead of one

**Challenge:** Flutter would give one UI codebase; we chose two shells around one core.
Isn't that double maintenance?
**Assessment:** Real cost, consciously accepted. Mitigations: all *logic* is in
`@kitabu/core` (one implementation); UI shells are thin; shared design tokens +
screen specs (UX.md) keep them parallel; screens are deliberately simple (notebook
metaphor, ~28 screens). The alternative (Flutter + TS server) duplicates the
highest-risk logic — sync/financial policies — which is worse (see
TECHNOLOGY-DECISIONS.md §3). Revisit only if UI maintenance measurably dominates.

## R2 — `node:sqlite` is marked experimental in Node 22

**Challenge:** building the core's default adapter on an experimental API?
**Assessment:** Bounded risk. The core talks to SQLite only through `SqlitePort`;
the Electron shell can use `better-sqlite3` (battle-tested, SQLCipher builds) and RN
uses `react-native-quick-sqlite`/`op-sqlite`. The Node adapter exists for dev/CI
(where it has been stable) and is covered by the same conformance tests as every
other adapter. Swap is a ~100-line adapter, not an architecture change.

## R3 — Op-log growth and compaction correctness

**Challenge:** an append-only op-log per device grows forever; compaction could lose
the ability to catch up a long-absent device.
**Mitigation:** compaction only after *all* peers + cloud ack past the cutoff
(SYNC.md §6); absent devices use snapshot+tail; snapshot/restore is the same code
path as backup/restore and cloud migration (one mechanism, multiply tested).
**Residual risk:** a device offline > retention with no snapshot contact — mitigated
by snapshot-on-any-contact and cloud; accepted.

## R4 — LWW-by-HLC for profile data can lose a field edit

**Challenge:** two devices edit the same tenant phone; one edit is overwritten
(brief §29 warns against blind LWW).
**Assessment:** Accepted *only* for low-stakes profile fields, with full before/after
in the audit log (recoverable in one tap) — the alternative (field-level CRDT merge)
is complexity the product brief warns against (§65-10). Financial data is never LWW:
it's append-only or conflict-queued (SYNC.md §5). Conflict-count telemetry in beta
will tell us if field-merge is ever needed.

## R5 — Android local-network flakiness (mDNS, hotspots, permissions)

**Challenge:** Level-2 sync is a headline promise; Android networking is fragmented
(mDNS multicast disabled on some OEMs, hotspot isolation, location permission for
Wi-Fi SSID).
**Mitigation:** layered strategy (SYNC.md §2.2): same-LAN mDNS → hotspot mode →
**manual host:port entry** (always works, zero discovery); Windows laptop as default
host (full Node stack, reliable); clear in-app guidance ("Connect both phones to the
same Wi-Fi, or use hotspot"). Hotspot mode documented with screenshots. Bluetooth
explicitly rejected for bulk data (brief §28).
**Residual:** some cheap-router environments will need manual entry; acceptable if
rare and guided.

## R6 — Receipt block exhaustion during long offline periods

**Challenge:** 500-number blocks; a device issuing thousands of receipts offline
could exhaust its block and be tempted to reuse numbers.
**Mitigation:** block size 500 is per-grant and grants are cheap (cloud/pairing
issues many blocks proactively — grant 5 blocks = 2,500 receipts); warn at 80%;
if truly exhausted while offline, issuance **stops with a clear explanation** rather
than ever duplicating a number (integrity over availability — brief §65-13). A
single offline device holds blocks 1–2500 at bootstrap; realistic caretaker volume is
< 200/month.

## R7 — SQLCipher availability across shells

**Challenge:** encryption-at-rest is promised; SQLCipher integration differs per
platform (Electron build flag, RN library choice, FIPS on Windows).
**Mitigation:** `SqlitePort.openEncrypted(path, key)` is part of the port contract;
M3 spikes SQLCipher on both shells *first* (before building screens) with fallbacks
(op-sqlite ships SQLCipher; Electron uses better-sqlite3+SQLCipher prebuilds;
worst case on Windows: EFS/BitLocker + container file encryption, documented as
degraded). Key management is OS keystore (SECURITY.md §2) — designed, not bolted on.

## R8 — Clock skew and HLC misuse

**Challenge:** HLC protects ordering, but device clocks wildly wrong (year 2030)
create hlc values that "win" every conflict until clocks heal.
**Mitigation:** HLC physical component clamps to max(seen, wall) — never decreases;
on observed wall-clock regress > threshold the app warns the user and audits it;
conflict queue surfaces anomalies rather than silently resolving. Tests include
skewed-clock partitions (SYNC.md §9).

## R9 — Cloud RLS misconfiguration leaks tenants (the unforgivable bug)

**Challenge:** one missed `CREATE POLICY` = cross-landlord leak (brief §65-8).
**Mitigation:** RLS is generated by one schema macro applied to **every** tenant
table (no per-table hand-written policies); an automated isolation suite hits every
endpoint cross-org on every CI run; deny-by-default policy posture; org id never
accepted from clients (SECURITY.md §3). Additionally: external security review before
any multi-tenant production launch (M10).

## R10 — M-Pesa sandbox instability and the temptation to fake it

**Challenge:** sandbox is flaky; tests "need" green; someone will be tempted to
stub VERIFIED (brief §15 explicitly forbids).
**Mitigation:** `FixtureProvider` (tests only) + a CI guard test that fails the build
if any fixture/sandbox provider is registered in production configuration
(M-PESA.md §6). Cultural rule in CONTRIBUTING: fake data in tests is fine; fake
*verification* in production paths is a firing-grade bug.

## R11 — Backup passphrase loss = permanent data loss

**Challenge:** offline-only user forgets the backup passphrase; encrypted backup is
unrecoverable by design.
**Mitigation:** 12-word recovery phrase shown once with plain-language warnings +
verify-by-typing-3-words; passphrase hint (user-chosen, non-revealing); reminder
cadence in Backup screen; cloud option presented as the alternative. This is the
crypto-honest tradeoff; it is explained in UX terms, never hidden.

## R12 — Electron memory footprint on 4 GB laptops

**Challenge:** NFR-03 (< 300 MB) is tight for Electron.
**Mitigation:** single window, lazy-loaded routes, no bundled Chromium codecs beyond
default, no background processes beyond sync-on-demand; measure in M3 with a
budget-device benchmark suite; escalate to Tauri *shell* (keeping the Node core via a
sidecar) only if measurements fail — the core is shell-agnostic by design
(ARCHITECTURE.md §3).

## R13 — Scope creep toward enterprise features

**Challenge:** the brief itself is large; the market is simple (brief §65-9/10).
**Mitigation:** PRD §6.3 explicit out-of-scope list; every feature proposal must cite
a persona (A/B/C) and a JTBD; dashboard shows numbers, not graphs; the "Landlord C
test" (can she use it alone in 10 minutes?) is applied at every milestone review.

## R14 — Sync correctness under adversarial topologies

**Challenge:** A→B→cloud→C plus A→C direct must not duplicate (brief §32–33).
**Mitigation:** single dedupe key (`changeId`) at every apply site — devices and
server share the same apply engine (the core), so there is exactly one dedupe
implementation; randomized topology fuzz test in M5 (generate random partitions and
merge orders; assert set-equality of final states and zero duplicate
payments/receipts).

## R15 — Multi-org-on-one-device deferred

**Challenge:** brief §7 says one user may belong to multiple orgs (professional
managers), but v1 installs are single-org.
**Mitigation:** every row already carries `org_id` and all queries are org-scoped;
the op-log is org-scoped; switching orgs later = multi-database files per org (each
stays isolated, encrypted separately) — a product decision, not a schema migration.
Documented; deliberately not built until a real persona demands it (R13).
