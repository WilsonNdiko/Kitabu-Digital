/**
 * CryptoPort — synchronous Ed25519 signing for receipt tamper-evidence
 * (docs/RECEIPTS.md §5, ADR-010 style provider seam).
 *
 * Synchronous on purpose: signing happens inside SQLite transactions.
 * Implementations: Node (node:crypto, in `@kitabu/core/node`), React Native
 * (react-native-quick-crypto), future: OS keystore-backed.
 *
 * Keys are stored/transferred as DER: SPKI (public) and PKCS8 (private).
 */

export interface Ed25519KeyPair {
  publicSpki: Uint8Array;
  privatePkcs8: Uint8Array;
}

/** AES-256-GCM result: ciphertext plus the 16-byte auth tag (kept separate). */
export interface AeadResult {
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

export interface CryptoPort {
  generateEd25519(): Ed25519KeyPair;
  signEd25519(privatePkcs8: Uint8Array, data: Uint8Array): Uint8Array;
  verifyEd25519(publicSpki: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean;
  /**
   * AES-256-GCM authenticated encryption for local encrypted backups
   * (SECURITY.md §4). `key` is 32 bytes, `iv` is 12 bytes.
   */
  aes256gcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): AeadResult;
  /**
   * Decrypt and verify. Throws if the key is wrong or the data was tampered
   * with (GCM auth failure).
   */
  aes256gcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Uint8Array;
  /** Cryptographically secure random bytes (backup salts and IVs). */
  randomBytes(length: number): Uint8Array;
}

export const CRYPTO_NOT_CONFIGURED_MESSAGE =
  'Digital signing is not available in this build of Kitabu. Receipts can still be issued without a cryptographic signature.';;
