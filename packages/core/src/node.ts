/**
 * @kitabu/core/node — Node.js entry: the `node:sqlite` adapter, the Ed25519
 * crypto port (node:crypto, synchronous), plus convenience openers. Used by
 * tests, CI, tooling, and the future server-side workers.
 * (Electron ships its own adapters; React Native never imports this entry.)
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { NodeSqliteAdapter, openNodeSqlite } from './db/nodeSqliteAdapter.ts';
import type { SqlitePort } from './db/port.ts';
import type { AeadResult, CryptoPort, Ed25519KeyPair } from './foundation/crypto.ts';
import { Kitabu } from './kitabu.ts';
import type { KitabuOptions } from './kitabu.ts';
import { readBackup } from './services/backup.ts';
import { KitabuError } from './foundation/errors.ts';

export { NodeSqliteAdapter, openNodeSqlite };
export type { SqlitePort };

/** Synchronous Ed25519 + AES-256-GCM over node:crypto (KeyObjects from DER). */
export class NodeCryptoPort implements CryptoPort {
  generateEd25519(): Ed25519KeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      publicSpki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      privatePkcs8: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })),
    };
  }

  signEd25519(privatePkcs8: Uint8Array, data: Uint8Array): Uint8Array {
    const key = createPrivateKey({ key: Buffer.from(privatePkcs8), format: 'der', type: 'pkcs8' });
    return new Uint8Array(nodeSign(null, Buffer.from(data), key));
  }

  verifyEd25519(publicSpki: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
    const key = createPublicKey({ key: Buffer.from(publicSpki), format: 'der', type: 'spki' });
    return nodeVerify(null, Buffer.from(data), key, Buffer.from(signature));
  }

  aes256gcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): AeadResult {
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    return { ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(cipher.getAuthTag()) };
  }

  aes256gcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Uint8Array {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(tag));
    try {
      return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
    } catch (cause) {
      throw new KitabuError('STORAGE', 'Decryption failed.', `AES-256-GCM auth failure: ${String(cause)}`);
    }
  }

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(nodeRandomBytes(length));
  }
}

/** In-memory Kitabu (tests / throwaway sessions). Crypto port included. */
export function openKitabuInMemory(options: Omit<KitabuOptions, 'sqlite' | 'crypto'> = {}): Kitabu {
  return Kitabu.open({ ...options, sqlite: openNodeSqlite(':memory:'), crypto: new NodeCryptoPort() });
}

/** File-backed Kitabu (the real local database of a device). Crypto port included. */
export function openKitabuFile(path: string, options: Omit<KitabuOptions, 'sqlite' | 'crypto'> = {}): Kitabu {
  return Kitabu.open({ ...options, sqlite: openNodeSqlite(path), crypto: new NodeCryptoPort() });
}

/**
 * Verify + restore an encrypted backup onto a fresh database and open it.
 * The backup is decrypted and validated BEFORE the caller swaps databases, so
 * a wrong passphrase never destroys existing data. `target` selects in-memory
 * or a file path; the file must not already contain an organization.
 */
export function openKitabuFromBackup(
  backup: Uint8Array,
  passphrase: string,
  target: { dbPath?: string } = {},
  options: Omit<KitabuOptions, 'sqlite' | 'crypto' | 'snapshot'> = {},
): Kitabu {
  const crypto = new NodeCryptoPort();
  const snapshot = readBackup(backup, passphrase, crypto);
  const sqlite = target.dbPath !== undefined ? openNodeSqlite(target.dbPath) : openNodeSqlite(':memory:');
  return Kitabu.openFromSnapshot({ ...options, sqlite, crypto, snapshot });
}
