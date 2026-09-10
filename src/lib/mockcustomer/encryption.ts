/**
 * Encrypt/decrypt helpers for MockCustomer credentials at rest.
 *
 * Thin wrapper over `lib/crypto` (the same AES-256-GCM primitive used by
 * CertnIntegration for its API key). Kept as a named alias inside the
 * `mockcustomer/` module so future rotations to a KMS-backed provider
 * only need to update this file and don't ripple through every call
 * site. Format is `<ivHex>:<tagHex>:<cipherHex>` — persisted as `String`
 * (not `Bytes`) so `prisma db push` round-trips cleanly.
 */

import { encrypt as encryptRaw, decrypt as decryptRaw } from '../crypto'

export function encryptMcSecret(plaintext: string): string {
  return encryptRaw(plaintext)
}

export function decryptMcSecret(ciphertext: string): string {
  return decryptRaw(ciphertext)
}
