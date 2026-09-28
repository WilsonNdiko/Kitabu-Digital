# Kitabu Digital — Synchronization Design

## 1. Principles

- The sync engine is a first-class subsystem, independent of the UI.
- Sync ships **changes**, never the whole database.
- Sync is **idempotent**: any change may arrive multiple times, via multiple paths, in any order after its causal parents.
- Same protocol for local (device↔device) and cloud (device↔cloud) sync; only the transport differs.

## 2. Change log

Every committed write appends, in the same SQLite transaction:

```
change_id   = chg_<ulid>                -- globally unique identity of the CHANGE
entity_type, entity_id, op(UPSERT|DELETE)
payload_json = full row after write     -- rows are small; full-row keeps apply simple
hlc          = hybrid logical clock "0001745…-0003-dev_x"  (physical ms, counter, device)
origin_device_id, org_id
```

- HLC gives a total order tolerant of wrong wall clocks (clock skew risk).
- `applied_changes(change_id)` table records every change ever applied ⇒ **dedup across paths**: if phone A's change reaches the laptop via LAN and later again via cloud, the second copy is recognized and skipped. Payments can never duplicate because the change_id — and the row id — are identical regardless of path.

## 3. Sync session protocol (both levels)

```
A → B : HELLO {device_id, org_id, proof-of-identity}
B → A : CURSOR {last_seq_received_from_A}        -- per-peer cursor in sync_peers
A → B : CHANGES [batch, ordered by local seq]
B     : for each change:
           skip if change_id ∈ applied_changes
           conflict-check against local row (see §5)
           apply in transaction + record applied_change  (no re-log as a new local change;
           forwarded changes keep their original change_id when relayed)
B → A : ACK {through_seq}
(then roles swap — sync is bidirectional)
```

Interrupted sync: cursors only advance on ACK; retry resends from the cursor; dedup makes resends harmless. Batches are capped (e.g. 500 changes) so cheap phones never hold huge payloads.

## 4. Local device↔device sync (no internet)

**Pairing (one-time):**
```
Landlord device: "Add Device" → generates QR {org_id, session key, IP:port, pairing token}
New device: scans QR → connects over LAN → proves token → exchanges device public keys
Landlord confirms → device row created (ACTIVE) → synced like any other entity
```

**Discovery & transport (every sync):**
1. Primary: both devices on the same LAN or on the landlord's phone **hotspot** (ubiquitous in Kenya). Discovery via mDNS (`_kitabu._tcp`) with QR/manual-IP fallback.
2. Transport: TCP with Noise-style encrypted channel; both sides authenticate with the device keys exchanged at pairing (mutual auth). Revoked devices fail authentication (revocation is itself a synced entity, and peers check status before serving).
3. Wi-Fi Direct is a future optimization on Android; never a dependency. Bluetooth is used at most for discovery hints — never for bulk transfer.

**Documents/files:** synced by content hash (sha256); a file is transferred at most once per peer, after the metadata row, resumable by byte range.

## 5. Conflict resolution — per entity type

Conflict = incoming change for a row whose local `version`/HLC has diverged from the change's parent.

| Entity | Policy |
|---|---|
| **Payments, ledger entries, receipts** | **Immutable events — no conflicts possible.** Rows are append-only; state changes (verify/reject/reverse) are new facts. Two devices verifying the same payment: idempotent (same resulting state). Verify vs. reject race: deterministic priority REVERSED > REJECTED > VERIFIED > VERIFYING > PENDING with the losing action surfaced in the audit log for the owner to review. |
| **Receipt issuance race** (two devices issue for one payment) | `UNIQUE(payment_id)` — deterministic winner = lower receipt id (earlier HLC); loser receipt is auto-voided and logged; numbering gap is acceptable (like a spoiled paper receipt). |
| **Tenant profile** | Field-level merge by HLC (last-writer-wins **per field**); conflicting edits to the same field: higher HLC wins, loser value preserved in `sync_conflicts` for review. |
| **Tenancy lifecycle** (move-in/move-out) | Explicit conflict: if two devices create ACTIVE tenancies for the same unit, the unique partial index blocks silent double-occupancy; the later one is parked as `sync_conflicts` requiring owner resolution. |
| **Rent amount** | Never overwritten — `rent_rates` rows with effective dates; concurrent rate rows for the same period → higher HLC wins, both kept in history. |
| **Property/unit config, expenses, maintenance** | Row-level LWW by HLC + conflict record when both sides edited. |
| **Deletes** | Soft deletes are just field updates; delete-vs-edit → edit wins (data preservation beats deletion), surfaced for review. |

**Golden rule: prefer modelling facts as immutable events so conflicts cannot exist.** LWW is confined to descriptive/config data.

## 6. Cloud sync (Level 3)

- Same protocol over HTTPS; the cloud is one more replica with per-device cursors, plus durable storage.
- Multi-path convergence (`Phone A → LAN → Laptop → Cloud → Phone B`) is safe because relayed changes keep their original `change_id`.
- **Local → Cloud migration** (offline user later creates an account): device registers org in cloud → uploads its full change history as one resumable session → cloud applies with the same dedup rules. Re-running migration is a no-op (idempotent). No duplicates by construction.
- **Device recovery:** new device signs in → owner authorizes it → downloads snapshot + change tail → becomes a normal replica.

## 7. Sync UX

- Persistent status chip: `● Offline` / `↻ N changes waiting` / `✓ Synced`. **Saved locally ≠ synced** — the UI copy makes the distinction explicit.
- Sync screen: pending local changes, nearby paired devices (available/last seen), cloud state, last syncs, `Sync Now`.
- Conflicts needing a human land in a simple "Needs review" list with plain-language descriptions, owner-only.
