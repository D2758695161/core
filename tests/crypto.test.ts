import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  verify,
  seal,
  open,
  toHex,
  fromHex,
} from '../src/crypto/index.js';

describe('crypto', () => {
  it('generateSigningKeyPair returns 32-byte public, 64-byte secret', () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);
  });

  it('generateEncryptionKeyPair returns 32-byte public, 32-byte secret', () => {
    const kp = generateEncryptionKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('sign + verify roundtrip', () => {
    const kp = generateSigningKeyPair();
    const msg = new TextEncoder().encode('hello world');
    const sig = sign(msg, kp.secretKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
  });

  it('verify with wrong key returns false', () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const msg = new TextEncoder().encode('hello');
    const sig = sign(msg, kp1.secretKey);
    expect(verify(msg, sig, kp2.publicKey)).toBe(false);
  });

  it('verify with tampered message returns false', () => {
    const kp = generateSigningKeyPair();
    const msg = new TextEncoder().encode('hello');
    const sig = sign(msg, kp.secretKey);
    const tampered = new TextEncoder().encode('hellx');
    expect(verify(tampered, sig, kp.publicKey)).toBe(false);
  });

  it('seal + open roundtrip', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('secret message');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);
    const opened = open(sealed, recipient.secretKey);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe('secret message');
  });

  it('open with wrong key returns null', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const wrong = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('secret');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);
    expect(open(sealed, wrong.secretKey)).toBeNull();
  });

  it('seal output format: 32 sender pubkey + 24 nonce + ciphertext', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('test');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);

    // First 32 bytes should be sender's public key
    const embeddedPubkey = sealed.slice(0, 32);
    expect(toHex(embeddedPubkey)).toBe(toHex(sender.publicKey));

    // Total length: 32 + 24 + (plaintext.length + 16 MAC)
    expect(sealed.length).toBe(32 + 24 + plaintext.length + 16);
  });
});
