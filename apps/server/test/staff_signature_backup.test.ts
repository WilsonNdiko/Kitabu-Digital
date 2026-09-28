import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKshToMinor } from '@kitabu/core';
import { getSetting, openDb, type Ctx, type DB } from '../src/db/index.js';
import { getCtx, runSetup } from '../src/services/setup.js';
import { createTenant } from '../src/services/portfolio.js';
import { issueReceipt, recordPayment, tenancyBalance, verifyPayment } from '../src/services/finance.js';
import { createUser, isLocked, listUsers, lockDevice, loginUser } from '../src/services/users.js';
import { getActiveSignature, setSignature } from '../src/services/signatures.js';
import { backupStatus, createBackup, restoreBackup } from '../src/services/backup.js';

const K = (s: string) => parseKshToMinor(s);
const today = new Date().toISOString().slice(0, 10);
const PNG = `data:image/png;base64,${Buffer.from('fake-signature-image-bytes').toString('base64')}`;

let dir: string;
let db: DB;
let ctx: Ctx;
let tenancyId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kitabu-test-'));
  db = openDb(join(dir, 'a.db'));
  runSetup(db, {
    ownerName: 'Wilson', pin: '1234', orgName: 'Green View Properties',
    propertyName: 'Green View Apartments', units: [{ label: 'A-1', rentMinor: K('12000') }],
  });
  ctx = getCtx(db)!;
  const unit = db.prepare('SELECT id FROM units').get() as any;
  tenancyId = createTenant(ctx, { fullName: 'John Kamau', moveIn: { unitId: unit.id, startDate: today } }).tenancyId!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('staff, roles & PIN lock', () => {
  it('owner adds a caretaker; caretaker cash lands PENDING; caretaker cannot verify', () => {
    const jane = createUser(ctx, { fullName: 'Jane Njoki', role: 'CARETAKER', pin: '5678' });
    loginUser(db, { userId: jane.id, pin: '5678' });
    const janeCtx = getCtx(db)!;
    expect(janeCtx.userRole).toBe('CARETAKER');

    const p = recordPayment(janeCtx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    expect(p.status).toBe('PENDING'); // caretaker cash needs owner/manager approval
    expect(() => verifyPayment(janeCtx, p.id)).toThrow(/owner or a manager/);

    loginUser(db, { userId: ctx.userId, pin: '1234' });
    const ownerCtx = getCtx(db)!;
    verifyPayment(ownerCtx, p.id);
    expect(tenancyBalance(ownerCtx, tenancyId)).toBe(0);
  });

  it('PIN is required and wrong PINs are rejected', () => {
    expect(() => loginUser(db, { userId: ctx.userId, pin: '9999' })).toThrow(/Wrong PIN/);
    expect(() => loginUser(db, { userId: ctx.userId })).toThrow(/Wrong PIN/);
    const u = loginUser(db, { userId: ctx.userId, pin: '1234' });
    expect(u.role).toBe('OWNER');
  });

  it('lock/unlock cycle works', () => {
    expect(isLocked(db)).toBe(false);
    lockDevice(db);
    expect(isLocked(db)).toBe(true);
    loginUser(db, { userId: ctx.userId, pin: '1234' });
    expect(isLocked(db)).toBe(false);
  });

  it('only the owner can add staff; roles are validated', () => {
    const jane = createUser(ctx, { fullName: 'Jane', role: 'CARETAKER' });
    loginUser(db, { userId: jane.id });
    const janeCtx = getCtx(db)!;
    expect(() => createUser(janeCtx, { fullName: 'X', role: 'MANAGER' })).toThrow(/Only the owner/);
    expect(() => createUser(ctx, { fullName: 'X', role: 'OWNER' as any })).toThrow(/role/);
    expect(listUsers(ctx)).toHaveLength(2);
  });
});

describe('digital signatures (§19)', () => {
  it('signature is embedded in receipts at issuance; replacing it never alters old receipts', () => {
    setSignature(ctx, { dataUrl: PNG });
    const p1 = recordPayment(ctx, { tenancyId, amountMinor: K('6000'), method: 'CASH' });
    const r1 = issueReceipt(ctx, p1.id);
    const snap1 = JSON.parse((db.prepare('SELECT snapshot_json FROM receipts WHERE id=?').get(r1.id) as any).snapshot_json);
    expect(snap1.signature.dataUrl).toBe(PNG);

    // owner replaces the signature
    const PNG2 = `data:image/png;base64,${Buffer.from('new-signature').toString('base64')}`;
    setSignature(ctx, { dataUrl: PNG2 });
    expect(getActiveSignature(ctx, null)!.dataUrl).toBe(PNG2);

    // old receipt still shows the ORIGINAL signature
    const snapAgain = JSON.parse((db.prepare('SELECT snapshot_json FROM receipts WHERE id=?').get(r1.id) as any).snapshot_json);
    expect(snapAgain.signature.dataUrl).toBe(PNG);

    // new receipts get the new signature
    const p2 = recordPayment(ctx, { tenancyId, amountMinor: K('6000'), method: 'CASH' });
    const r2 = issueReceipt(ctx, p2.id);
    const snap2 = JSON.parse((db.prepare('SELECT snapshot_json FROM receipts WHERE id=?').get(r2.id) as any).snapshot_json);
    expect(snap2.signature.dataUrl).toBe(PNG2);
  });

  it('rejects non-images and oversized images; only the owner may change it', () => {
    expect(() => setSignature(ctx, { dataUrl: 'data:text/html;base64,PGI+' })).toThrow(/PNG or JPG/);
    expect(() => setSignature(ctx, { dataUrl: `data:image/png;base64,${'A'.repeat(500_000)}` })).toThrow(/too large/);
    const jane = createUser(ctx, { fullName: 'Jane', role: 'MANAGER' });
    loginUser(db, { userId: jane.id });
    expect(() => setSignature(getCtx(db)!, { dataUrl: PNG })).toThrow(/Only the owner/);
  });
});

describe('encrypted backup & restore (§36–37)', () => {
  it('full roundtrip: backup → restore on a fresh device → identical books', () => {
    recordPayment(ctx, { tenancyId, amountMinor: K('8000'), method: 'CASH' });
    setSignature(ctx, { dataUrl: PNG });
    const buf = createBackup(db, 'siri-kali-2026');
    expect(backupStatus(db).lastBackupAt).toBeTruthy();
    expect(buf.subarray(0, 8).toString()).toBe('KITABU01');
    expect(buf.includes(Buffer.from('SQLite format 3'))).toBe(false); // actually encrypted

    const fresh = openDb(join(dir, 'restored.db'));
    const res = restoreBackup(fresh, buf, 'siri-kali-2026');
    expect(res.orgName).toBe('Green View Properties');

    const freshCtx = getCtx(fresh)!;
    expect((fresh.prepare('SELECT COUNT(*) c FROM tenants').get() as any).c).toBe(1);
    expect((fresh.prepare('SELECT COUNT(*) c FROM payments').get() as any).c).toBe(1);
    expect(tenancyBalance(freshCtx, tenancyId)).toBe(K('4000'));
    expect(getActiveSignature(freshCtx, null)!.dataUrl).toBe(PNG);
    // the restored install is a NEW device in the same org (own receipt book)
    expect(freshCtx.deviceId).not.toBe(ctx.deviceId);
    expect((fresh.prepare('SELECT COUNT(*) c FROM devices').get() as any).c).toBe(2);
    // it asks who is using it on first open
    expect(getSetting(fresh, 'locked')).toBe('1');
  });

  it('wrong passphrase and damaged files are rejected safely', () => {
    const buf = createBackup(db, 'siri-kali-2026');
    const fresh = openDb(':memory:');
    expect(() => restoreBackup(fresh, buf, 'wrong-pass')).toThrow(/Wrong passphrase|damaged/);
    const corrupted = Buffer.from(buf);
    corrupted[corrupted.length - 5] ^= 0xff;
    expect(() => restoreBackup(fresh, corrupted, 'siri-kali-2026')).toThrow(/Wrong passphrase|damaged/);
    expect(() => restoreBackup(fresh, Buffer.from('not a backup'), 'x')).toThrow(/not a Kitabu backup/);
    // fresh device remains untouched
    expect(getSetting(fresh, 'org_id')).toBeNull();
  });

  it('short passphrases are refused; restore refuses to overwrite an existing setup', () => {
    expect(() => createBackup(db, '123')).toThrow(/at least 6/);
    const buf = createBackup(db, 'siri-kali-2026');
    expect(() => restoreBackup(db, buf, 'siri-kali-2026')).toThrow(/already set up/);
  });
});
