import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';

export function generateSigningKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  return nacl.sign.keyPair();
}

export function generateEncryptionKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  return nacl.box.keyPair();
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}

export function seal(
  plaintext: Uint8Array,
  recipientPubkey: Uint8Array,
  senderSecretKey: Uint8Array,
): Uint8Array {
  const senderKeyPair = nacl.box.keyPair.fromSecretKey(senderSecretKey);
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.box(plaintext, nonce, recipientPubkey, senderSecretKey);
  if (!encrypted) throw new Error('encryption_failed');

  const sealed = new Uint8Array(32 + 24 + encrypted.length);
  sealed.set(senderKeyPair.publicKey, 0);
  sealed.set(nonce, 32);
  sealed.set(encrypted, 56);
  return sealed;
}

export function open(
  sealed: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  if (sealed.length < 56) return null;
  const senderPubkey = sealed.slice(0, 32);
  const nonce = sealed.slice(32, 56);
  const ciphertext = sealed.slice(56);
  return nacl.box.open(ciphertext, nonce, senderPubkey, recipientSecretKey);
}

export function sha256(data: Uint8Array): Uint8Array {
  const hash = createHash('sha256').update(data).digest();
  return new Uint8Array(hash);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
