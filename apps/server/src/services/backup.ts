/**
 * Encrypted local backup & restore (brief §36–37, docs/SECURITY.md §2).
 *
 * Backup = the entire SQLite file, encrypted with AES-256-GCM under a key
 * derived from the landlord's passphrase (scrypt). A lost backup file exposes
 * nothing without the passphrase.
 *
 * Restore = "local join": the backup is opened as a read-only source and its
 * change history is replayed through the SAME idempotent sync engine used for
 * device pairing. The restored install becomes a fresh device in the same
 * organization — receipts keep their numbers, ledgers stay intact, and a later
 * sync with surviving devices cannot create duplicates.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, getSetting, insertRow, nowIso, openDb, setSetting, type DB } from '../db/index.js';
import { getCtx } from './setup.js';
import { applyChanges, getChangesSince } from '../sync/engine.js';

const MAGIC = Buffer.from('KITABU01');

export function createBackup(db: DB, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 6) throw new AppError('Choose a backup passphrase of at least 6 characters.');
  if (!getSetting(db, 'org_id')) throw new AppError('Nothing to back up yet.', 409);
  if (db.path === ':memory:') throw new AppError('Backups need a file-based database.');

  db.checkpoint();
  const plain = readFileSync(db.path);

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  setSetting(db, 'last_backup_at', nowIso());
  return Buffer.concat([MAGIC, salt, iv, tag, enc]);
}

export function restoreBackup(db: DB, file: Buffer, passphrase: string) {
  if (getSetting(db, 'org_id')) throw new AppError('This device is already set up — restore only works on a fresh install.', 409);
  if (file.length < MAGIC.length + 16 + 12 + 16 + 100 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new AppError('That file is not a Kitabu backup.');
  }
  let off = MAGIC.length;
  const salt = file.subarray(off, off += 16);
  const iv = file.subarray(off, off += 12);
  const tag = file.subarray(off, off += 16);
  const enc = file.subarray(off);

  let plain: Buffer;
  try {
    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    throw new AppError('Wrong passphrase, or the backup file is damaged.');
  }
  if (!plain.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) {
    throw new AppError('The backup file is damaged.');
  }

  const tmpPath = join(tmpdir(), `kitabu-restore-${randomBytes(6).toString('hex')}.db`);
  writeFileSync(tmpPath, plain);
  try {
    const src = openDb(tmpPath);
    const orgId = getSetting(src, 'org_id');
    const userId = getSetting(src, 'user_id');
    const syncKey = getSetting(src, 'sync_key');
    if (!orgId || !userId) throw new AppError('The backup file is damaged (no organization inside).');

    setSetting(db, 'org_id', orgId);
    setSetting(db, 'user_id', userId);
    if (syncKey) setSetting(db, 'sync_key', syncKey);
    setSetting(db, 'receipt_seq', '0');

    const ctx = getCtx(db)!;
    const changes = getChangesSince(src, 0, 10_000_000);
    const res = applyChanges(ctx, changes);

    // this install becomes a new, authorized device in the organization
    const already = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(ctx.deviceId);
    if (!already) {
      insertRow(ctx, 'devices', {
        id: ctx.deviceId, org_id: orgId, name: 'Restored device', platform: process.platform,
        device_code: ctx.deviceCode, public_key: null, status: 'ACTIVE', paired_at: nowIso(), last_sync_at: null,
      });
    }
    setSetting(db, 'locked', '1'); // ask "who is using this device?" on first open
    const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as any;
    return { ...res, orgName: org?.name ?? '' };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

export function backupStatus(db: DB) {
  return { lastBackupAt: getSetting(db, 'last_backup_at') };
}
