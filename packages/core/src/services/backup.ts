/**
 * Local encrypted backup export/restore (PRD FR-22, NFR-09; SECURITY.md §4;
 * SYNC.md §6).
 *
 * Archive format (version 1), all integers little-endian:
 *
 *   "KITABUBK"  8 bytes   magic
 *   fmtVersion  u16       archive format version (=1)
 *   kdfId       u16       1 = Argon2id (RFC 9106)
 *   m           u32       Argon2 memory in KiB
 *   t           u32       Argon2 passes
 *   p           u8        Argon2 lanes
 *   salt        16 bytes  Argon2 salt (fresh per export)
 *   iv          12 bytes  AES-256-GCM nonce (fresh per export)
 *   ciphertext  …         AES-256-GCM over the canonical-JSON snapshot
 *   tag         16 bytes  GCM auth tag
 *
 * The key is derived from the passphrase with Argon2id and is never stored;
 * the passphrase is never stored either (SECURITY.md). The snapshot contains
 * all live rows of the 17 synced tables plus the schema version (SYNC.md §6).
 * `app_settings` and `change_log` are local-only and excluded.
 *
 * The KDF parameters live in the header, so files stay readable if the default
 * is raised later. Default = OWASP-recommended minimum (19 MiB, t=2, p=1);
 * ~1 s on a laptop CPU with this implementation.
 */

import type { SqlitePort, SqliteValue } from '../db/port.ts';
import { allRows } from '../db/port.ts';
import { migrate, SCHEMA_VERSION } from '../db/schema.ts';
import { insertRow } from '../db/crud.ts';
import type { TableName } from '../db/crud.ts';
import { canonicalJson } from '../foundation/canonicaljson.ts';
import { utf8Bytes, utf8Text } from '../foundation/sha256.ts';
import { bytesToBase64, base64ToBytes } from '../foundation/base64.ts';
import { argon2id } from '../foundation/argon2.ts';
import type { CryptoPort } from '../foundation/crypto.ts';
import { KitabuError, validationError, domainRule } from '../foundation/errors.ts';

/* ------------------------------------------------------------------ */
/* Snapshot payload                                                    */
/* ------------------------------------------------------------------ */

export const SNAPSHOT_MAGIC = 'KITABU-SNAPSHOT';

/**
 * FK-safe insertion order. `signature_images` must precede `receipts`
 * (receipts.signature_image_id); `payments` precedes `ledger_entries` and
 * `payment_allocations`; `ledger_entries` precede `payment_allocations`.
 */
export const SNAPSHOT_TABLE_ORDER: readonly TableName[] = [
  'organizations',
  'devices',
  'users',
  'properties',
  'buildings',
  'units',
  'tenants',
  'tenancies',
  'rent_rates',
  'audit_log',
  'payments',
  'ledger_entries',
  'payment_allocations',
  'signature_images',
  'receipts',
  'receipt_number_blocks',
  'org_keys',
];

/** BLOB values travel as { $blob: base64 } — collision-free (SQLite row values are never objects). */
export interface SnapshotBlobMarker {
  $blob: string;
}

export type SnapshotRow = Record<string, SqliteValue | SnapshotBlobMarker>;

export type SnapshotTable = Partial<Record<TableName, SnapshotRow[]>>;

export interface SnapshotPayload {
  magic: typeof SNAPSHOT_MAGIC;
  schemaVersion: number;
  exportedAt: string; // ISO timestamp
  org: { id: string; name: string };
  tables: SnapshotTable;
  counts: Partial<Record<TableName, number>>;
}

/** Blob marker: BLOB values travel as { $blob: base64 } — collision-free since
 *  SQLite row values are never objects. */
const BLOB_KEY = '$blob';

function encodeRowValue(value: SqliteValue): SqliteValue | SnapshotBlobMarker {
  if (value instanceof Uint8Array) return { [BLOB_KEY]: bytesToBase64(value) };
  if (typeof value === 'bigint') {
    // node:sqlite normally returns safe numbers; guard anyway.
    if (Number.isSafeInteger(Number(value))) return Number(value);
    throw new KitabuError('STORAGE', 'Backup failed: a value is too large to export.', `bigint ${value.toString()}`);
  }
  return value;
}

function decodeRowValue(value: unknown): SqliteValue {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record[BLOB_KEY] === 'string' && Object.keys(record).length === 1) {
      return base64ToBytes(record[BLOB_KEY] as string);
    }
  }
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  throw new KitabuError('STORAGE', 'This backup file contains unsupported data.', `unexpected value ${String(value)}`);
}

/** Build a snapshot of all live rows (SYNC.md §6). */
export function buildSnapshot(db: SqlitePort, nowIso: string): SnapshotPayload {
  const org = allRows(db, 'SELECT id, name FROM organizations WHERE deleted_at IS NULL');
  if (org.length === 0) {
    throw new KitabuError('NOT_BOOTSTRAPPED', 'Set up your organization before exporting a backup.');
  }
  const tables: SnapshotTable = {};
  const counts: Partial<Record<TableName, number>> = {};
  for (const table of SNAPSHOT_TABLE_ORDER) {
    const rows = allRows(db, `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY rowid`) as Array<Record<string, SqliteValue>>;
    tables[table] = rows.map((row) => {
      const out: SnapshotRow = {};
      for (const [k, v] of Object.entries(row)) out[k] = encodeRowValue(v);
      return out;
    });
    counts[table] = rows.length;
  }
  return {
    magic: SNAPSHOT_MAGIC,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso,
    org: { id: (org[0] as { id: string }).id, name: (org[0] as { name: string }).name },
    tables,
    counts,
  };
}

/**
 * Apply a snapshot to a *fresh* database (migrated, no organization yet).
 * Runs in one transaction; row counts are verified after insert.
 */
export function applySnapshot(db: SqlitePort, payload: SnapshotPayload): void {
  if (payload.magic !== SNAPSHOT_MAGIC || typeof payload.schemaVersion !== 'number' || !payload.org || !payload.tables) {
    throw domainRule('This file is not a valid Kitabu snapshot.', 'snapshot payload failed shape validation');
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new KitabuError(
      'SCHEMA',
      'This backup was made with a different version of Kitabu. Update the app and try again.',
      `snapshot schemaVersion=${payload.schemaVersion}, app SCHEMA_VERSION=${SCHEMA_VERSION}`,
    );
  }
  migrate(db);
  const existing = allRows(db, 'SELECT id FROM organizations WHERE deleted_at IS NULL LIMIT 1');
  if (existing.length > 0) {
    throw domainRule('This device already has an organization on it. Clear it before restoring a backup.', 'applySnapshot on non-empty db');
  }

  db.transaction(() => {
    for (const table of SNAPSHOT_TABLE_ORDER) {
      const rows = payload.tables[table] ?? [];
      for (const row of rows) {
        const decoded: Record<string, SqliteValue> = {};
        for (const [k, v] of Object.entries(row)) decoded[k] = decodeRowValue(v);
        insertRow(db, table, decoded);
      }
    }
    // Verify what we inserted — a truncated or corrupted snapshot stops here.
    for (const table of SNAPSHOT_TABLE_ORDER) {
      const expected = payload.counts?.[table] ?? payload.tables[table]?.length ?? 0;
      const actual = (allRows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`)[0] as { n: number }).n;
      if (actual !== expected) {
        throw new KitabuError(
          'SCHEMA',
          'This backup file is incomplete or damaged. Restore cancelled.',
          `table ${table}: expected ${expected} rows, inserted ${actual}`,
        );
      }
    }
    const org = allRows(db, `SELECT id, name FROM organizations WHERE id = ? AND deleted_at IS NULL`, [payload.org.id]);
    if (org.length === 0) {
      throw new KitabuError('SCHEMA', 'This backup file is incomplete or damaged. Restore cancelled.', 'organization row missing after apply');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Encrypted archive                                                   */
/* ------------------------------------------------------------------ */

/** Argon2id cost parameters. Defaults follow the OWASP-recommended minimum. */
export interface BackupKdfParams {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

export const BACKUP_KDF_DEFAULTS: BackupKdfParams = { memoryKiB: 19456, passes: 2, parallelism: 1 };

export const BACKUP_MAGIC = 'KITABUBK';
export const BACKUP_FORMAT_VERSION = 1;
const KDF_ARGON2ID = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
// magic(8) + u16 + u16 + u32 + u32 + u8 + salt(16) + iv(12)
const HEADER_LENGTH = 8 + 2 + 2 + 4 + 4 + 1 + SALT_LENGTH + IV_LENGTH;

export const MIN_PASSPHRASE_LENGTH = 8;

export interface CreateBackupOptions {
  crypto: CryptoPort;
  /** Override KDF cost (tests use tiny values). */
  params?: Partial<BackupKdfParams>;
  /** Injectable for deterministic tests. */
  salt?: Uint8Array;
  iv?: Uint8Array;
  nowIso: string;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function writeU16le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function writeU32le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/** Export the whole live database as one passphrase-encrypted archive. */
export function createBackup(db: SqlitePort, passphrase: string, options: CreateBackupOptions): Uint8Array {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw validationError(
      `Choose a backup passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      `passphrase length ${passphrase?.length ?? 0}`,
    );
  }
  const params: BackupKdfParams = { ...BACKUP_KDF_DEFAULTS, ...options.params };
  const salt = options.salt ?? options.crypto.randomBytes(SALT_LENGTH);
  const iv = options.iv ?? options.crypto.randomBytes(IV_LENGTH);

  const payload = buildSnapshot(db, options.nowIso);
  const plaintext = utf8Bytes(canonicalJson(payload));

  const key = argon2id({
    password: utf8Bytes(passphrase),
    salt,
    memoryKiB: params.memoryKiB,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLen: 32,
  });
  const { ciphertext, tag } = options.crypto.aes256gcmEncrypt(key, iv, plaintext);

  const out = new Uint8Array(HEADER_LENGTH + ciphertext.length + TAG_LENGTH);
  out.set(utf8Bytes(BACKUP_MAGIC), 0);
  writeU16le(out, 8, BACKUP_FORMAT_VERSION);
  writeU16le(out, 10, KDF_ARGON2ID);
  writeU32le(out, 12, params.memoryKiB);
  writeU32le(out, 16, params.passes);
  out[20] = params.parallelism;
  out.set(salt, 21);
  out.set(iv, 21 + SALT_LENGTH);
  out.set(ciphertext, HEADER_LENGTH);
  out.set(tag, HEADER_LENGTH + ciphertext.length);
  return out;
}

/**
 * Decrypt + verify an archive and return its snapshot. Throws a friendly
 * DOMAIN_RULE error when the passphrase does not match or the file was
 * damaged — nothing is written anywhere by this function.
 */
export function readBackup(backup: Uint8Array, passphrase: string, crypto: CryptoPort): SnapshotPayload {
  if (backup.length < HEADER_LENGTH + TAG_LENGTH) {
    throw validationError('This file is too short to be a Kitabu backup.', `length ${backup.length}`);
  }
  if (backup.length < 8 || asciiAt(backup, 0) !== BACKUP_MAGIC) {
    throw validationError('This file is not a Kitabu backup.', `length=${backup.length}`);
  }
  const fmtVersion = u16le(backup, 8);
  if (fmtVersion !== BACKUP_FORMAT_VERSION) {
    throw new KitabuError(
      'SCHEMA',
      'This backup uses a newer archive format. Update the app and try again.',
      `archive format ${fmtVersion}`,
    );
  }
  const kdfId = u16le(backup, 10);
  if (kdfId !== KDF_ARGON2ID) {
    throw new KitabuError('SCHEMA', 'This backup uses an unknown key derivation method.', `kdfId=${kdfId}`);
  }
  const memoryKiB = u32le(backup, 12);
  const passes = u32le(backup, 16);
  const parallelism = backup[20]!;
  const salt = backup.subarray(21, 21 + SALT_LENGTH);
  const iv = backup.subarray(21 + SALT_LENGTH, HEADER_LENGTH);
  const ciphertext = backup.subarray(HEADER_LENGTH, backup.length - TAG_LENGTH);
  const tag = backup.subarray(backup.length - TAG_LENGTH);

  const key = argon2id({
    password: utf8Bytes(passphrase ?? ''),
    salt: new Uint8Array(salt),
    memoryKiB,
    passes,
    parallelism,
    tagLen: 32,
  });

  let plaintext: Uint8Array;
  try {
    plaintext = crypto.aes256gcmDecrypt(key, new Uint8Array(iv), new Uint8Array(ciphertext), new Uint8Array(tag));
  } catch {
    throw validationError('That passphrase does not match this backup, or the file is damaged.');
  }

  let payload: SnapshotPayload;
  try {
    payload = JSON.parse(utf8Text(plaintext)) as SnapshotPayload;
  } catch {
    throw validationError('That passphrase does not match this backup, or the file is damaged.', 'snapshot JSON parse failed');
  }
  return payload;
}

/** Read an ASCII string from bytes (no Buffer dependency). */
function asciiAt(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < BACKUP_MAGIC.length; i++) {
    out += String.fromCharCode(bytes[offset + i]!);
  }
  return out;
}
