/**
 * @kitabu/core/node — Node.js entry: the `node:sqlite` adapter, the Ed25519
 * crypto port (node:crypto, synchronous), plus convenience openers. Used by
 * tests, CI, tooling, and the future server-side workers.
 * (Electron ships its own adapters; React Native never imports this entry.)
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { NodeSqliteAdapter, openNodeSqlite } from './db/nodeSqliteAdapter.ts';
import type { SqlitePort } from './db/port.ts';
import type { CryptoPort, Ed25519KeyPair } from './foundation/crypto.ts';
import { Kitabu } from './kitabu.ts';
import type { KitabuOptions } from './kitabu.ts';

export { NodeSqliteAdapter, openNodeSqlite };
export type { SqlitePort };

/** Synchronous Ed25519 signing over node:crypto (KeyObjects from DER). */
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
}

/** In-memory Kitabu (tests / throwaway sessions). Crypto port included. */
export function openKitabuInMemory(options: Omit<KitabuOptions, 'sqlite' | 'crypto'> = {}): Kitabu {
  return Kitabu.open({ ...options, sqlite: openNodeSqlite(':memory:'), crypto: new NodeCryptoPort() });
}

/** File-backed Kitabu (the real local database of a device). Crypto port included. */
export function openKitabuFile(path: string, options: Omit<KitabuOptions, 'sqlite' | 'crypto'> = {}): Kitabu {
  return Kitabu.open({ ...options, sqlite: openNodeSqlite(path), crypto: new NodeCryptoPort() });
}
