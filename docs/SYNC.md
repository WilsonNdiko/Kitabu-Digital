# Synchronization Design

Three levels, **one protocol**: an append-only **operation log (op-log)** exchanged
between peers (device or cloud). This document specifies the protocol, transports,
apply algorithm, conflict policies, and topology/deduplication guarantees.

## 1. Model

- Every mutation on any device is captured in the same transaction as the data change
  into `change_log` as one **op**:
  ```json
  {
    "changeId": "01JD7Z8G9H0Q1R2S3T4U5V6W7X",     // ULID — global, dedupe key
    "orgId": "018f3a…",
    "table": "tenancies",
    "rowId": "018f3b…",
    "op": "UPSERT",                               // v1: UPSERT only (soft delete in payload)
    "rowVersion": 3,                              // row revision this op writes
    "hlc": "0001730000000.000042.018f…",          // ordering (physical.ms.counter.device)
    "originDeviceId": "018f2c…",
    "actorUserId": "018f4d…",
    "payload": { /* full row snapshot after the change */ }
  }
  ```
- Each device's `change_log` is its **complete op stream** (own + relayed). Sync between
  two peers = "give me everything you have that I haven't acked" + "here's mine".
- Ordering key: `(hlc, changeId)`. HLCs (hybrid logical clocks) tolerate clock skew —
  a device whose clock is 10 minutes fast cannot outrank causally-later events.

## 2. Level 2 — local device sync without internet

### 2.1 Pairing (one-time, QR)

```
Owner: Settings → Devices → Add Device
  → shows QR: { orgId, deviceId, devicePubKey(Ed25519), pairingToken(128-bit, 5-min TTL),
               appName, v:1 }
New device scans → connects to the advertising device → mutual Ed25519 challenge/response
  → both store peer identity (key-pinned) → new device receives org snapshot bootstrap
  → device appears in org device list (synced `devices` row, status ACTIVE)
```

Pairing requires a **physical meeting** (QR scan) — trust is established by presence,
not by network reachability. The pairing token is single-use and expires; the device
key pair (generated per device, private key in OS keystore) is what authenticates all
future sessions.

### 2.2 Discovery

Priority order (most reliable first):

1. **Same LAN (router/h office Wi-Fi):** mDNS/DNS-SD `_kitabu._tcp.local` advertisement
   by the sync host (Windows laptop or any Android). Peers browse and connect.
2. **Phone hotspot:** caretaker's phone hotspot or landlord's phone hotspot — the other
   device joins; sync host advertises on the hotspot subnet (mDNS; Android hotspots do
   not isolate clients by default).
3. **Manual:** the host displays `host:port` (large, simple) for one-time entry —
   the guaranteed fallback when discovery is flaky.

Wi-Fi Direct and Bluetooth are **not** used for data transfer: Bluetooth is too slow
for databases and Wi-Fi Direct is unreliable across Android OEMs. Both may later assist
*discovery only*. The reliable mechanism is IP over Wi-Fi/LAN/hotspot.

### 2.3 Transport & encryption

- Windows (Electron, full Node): HTTPS server (TLS 1.3) with a per-device self-signed
  certificate whose fingerprint was exchanged at pairing (certificate pinning) —
  hosts the sync endpoint by default (the landlord's laptop is the natural rendezvous).
- Android ↔ Android: TCP socket (`react-native-tcp-socket`) with a framed session
  protocol: X25519 ECDH (keys from pinned Ed25519 identities) → session key →
  XChaCha20-Poly1305 (or AES-256-GCM) framed messages. Same message bodies as HTTPS.
- All payloads additionally ride inside the op-log which the local DB already encrypts
  at rest; transport encryption prevents LAN eavesdropping/tampering (receipt digests,
  signatures, and `hlc` ordering provide integrity even if a peer were malicious).

### 2.4 Session protocol

```
HELLO        {deviceId, orgId, protocolV, lastReceivedCursor}   → identity + authz check
HELLO_ACK    {deviceId, capabilities, head}                      → or REJECT (revoked/unknown key)
PULL         {sinceCursor, limit}   →  OPS {batch, ops[], continueCursor}
PUSH         {batch, ops[]}         →  PUSH_RESULT {results: [{changeId, status, rowVersion?}]}
ACK          {changeIds[]}          →  sender marks per-peer watermark (sync_state)
BYE          {summary}
```

- Batches are ACKed per batch; a crash mid-session loses nothing (peer watermarks move
  only after durable apply + ack).
- Any device can host; roles are negotiated in HELLO (both sides push and pull).
- A **revoked** device (status REVOKED in the org device list, which arrives via op-log
  or cloud) fails HELLO immediately and can never re-pair without a new physical QR.

## 3. Level 3 — cloud sync (optional)

- Same protocol over HTTPS to the Kitabu API; device authenticates with account JWT
  (from sign-in) **and** device key attestation header (binds JWT to the registered
  device — a stolen token without the device key cannot sync).
- Server holds the authoritative `org_changes` stream (append-only, ULID-keyed). It
  applies ops with the **same policy engine as devices** (`@kitabu/core` imported by
  NestJS) and serves pulls.
- Sequence/entitlement actions only the server performs: granting receipt-number
  blocks, issuing new device pairing tokens, storage quotas.
- First cloud link (local → cloud migration): device uploads a **snapshot** (see §6)
  + op-log tail. Server ingests snapshot rows idempotently (by row id) then replays the
  tail — no duplicates, no renumbering, existing receipt numbers preserved.

## 4. Apply algorithm (identical on devices and server)

For each incoming op, in a single transaction:

```
1. dedupe   : changeId already in change_log?  → SKIP (DUPLICATE), still ack.
2. load row : row exists?
     no     → apply payload as insert (DELETE op on unknown row: record tombstone op only).
     yes    → compare op.rowVersion with row.version:
                op.rowVersion > row.version  → candidate apply
                op.rowVersion == row.version → payload identical? DUPLICATE : CONFLICT
                op.rowVersion < row.version  → STALE (skip, ack)
3. policy   : candidate/concurrent edits resolved per-entity (§5 table).
4. apply    : write row (version = op.rowVersion; hlc = op.hlc), run post-apply hooks
              (e.g. recompute unit occupancy), append audit, insert op into local
              change_log for relay to other peers.
5. ack      : report APPLIED | DUPLICATE | STALE | CONFLICT_QUEUED.
```

Interrupted sessions, retries, and duplicate deliveries are safe: **every step is
idempotent**, keyed on `changeId` and guarded by row `version`.

## 5. Conflict policies per entity

| Entity | Policy | Rationale |
|---|---|---|
| tenants (profile) | **LWW by HLC**, full audit of overwritten values | Profile edits are rare, low-stakes, and recoverable from audit |
| properties, buildings, units | LWW by HLC | Same; label conflicts surface in audit |
| units.status | **Derived recompute** — occupancy is recomputed from tenancies, never blindly taken | Status is a projection, not primary data |
| tenancies | **Explicit queue** — concurrent conflicting writes (e.g. two different tenants placed in one unit offline) → conflict review; DB unique index prevents double-let regardless | Occupancy is a real-world fact; software must not guess |
| rent_rates | Append-only; conflicting effective-date overlap → conflict queue | Financial history |
| payments, ledger_entries | **Immutable inserts.** INSERT-INSERT on unique reference (M-Pesa code) → later hlc is auto-flagged `REJECTED` (duplicate ref) + conflict entry; never deleted | Never lose or duplicate money records |
| receipts | Immutable; duplicate number (block misuse) → conflict queue | Legal documents |
| audit_log | Append-only union (all entries kept, ordered by hlc) | No conflicts by construction |
| devices | Owner-authoritative: revocation ops apply strictly (REVOKED wins) | Security |

The owner's conflict screen shows local vs remote, entity history, and one-tap
resolutions ("Keep mine", "Take theirs", "Keep both" where meaningful). The queue is
designed to stay **tiny** — the entity design (append-only finance, derived status)
removes most conflict classes by construction.

## 6. Snapshots, compaction, and catch-up

- **Snapshot** = full dump of all live rows (per org) + schema version. Used by:
  new-device onboarding after pairing, backup export/restore, local→cloud migration.
  Snapshot + op-tail (ops newer than snapshot hlc) = complete state transfer.
- **Compaction:** when every known peer (and the cloud, if linked) has acked ops older
  than the retention cutoff (default 30 days), those ops are deleted locally. The op-log
  therefore stays bounded; catch-up of a *long-absent* device uses snapshot + tail
  instead of replaying months of ops.
- **New device** (post-pairing or post-restore): snapshot restore → watermark set to
  snapshot hlc → normal incremental sync.

## 7. Topology & duplicate prevention (the brief's §32/§33 test)

```
Phone A ──local──► Laptop B ──cloud──► Server ──cloud──► Phone C
```

A records payment P (op X). Local sync: B applies X, relays nothing new (B pushes only
ops *its peers* haven't acked; A's op is now in B's log and flows to B's peers).
B→cloud push: server dedupes on `changeId X`. C pulls from cloud: receives X once.
If C also local-syncs with A directly, the `changeId` dedupe makes the second delivery
a no-op. **The same logical change can traverse any path any number of times; it is
applied exactly once everywhere.** Receipt numbering cannot collide (reserved blocks,
§RECEIPTS) and M-Pesa references cannot duplicate (unique index). Automated topology
tests in M5 replay exactly this graph, including offline partitions and re-merges.

## 8. Sync status UX (see UX.md §offline)

- Persistent chip: `✓ All synced` · `↻ 3 changes waiting` · `● Offline`
- Explicit distinction: **Saved locally ≠ synced.** Every save toast states which.
- Sync screen: local pending count, nearby devices (available/last seen), cloud state
  (connected/not linked/last sync time), per-peer last sync, "Sync now" button.

## 9. Testing strategy (per the brief §58)

- Unit: HLC ordering under skew; apply idempotency; each policy.
- Property-style: randomized concurrent edit sequences converge to identical states.
- Scenario ("Green View"): 3 devices, 3-day offline partition, mixed operations,
  LAN merge, cloud merge, fresh-device restore — asserting zero duplicates, zero
  losses, preserved history, deterministic convergence.
- Negative: revoked device rejected; foreign-org peer rejected; tampered payload
  (digest mismatch) rejected; replayed/interleaved batches applied exactly once.
