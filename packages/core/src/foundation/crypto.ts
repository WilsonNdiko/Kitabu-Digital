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

export interface CryptoPort {
  generateEd25519(): Ed25519KeyPair;
  signEd25519(privatePkcs8: Uint8Array, data: Uint8Array): Uint8Array;
  verifyEd25519(publicSpki: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean;
}

export const CRYPTO_NOT_CONFIGURED_MESSAGE =
  'Digital signing is not available in this build of Kitabu. Receipts can still be issued without a cryptographic signature.';
