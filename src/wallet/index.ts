import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  toHex,
  fromHex,
} from '../crypto/index.js';

export interface Wallet {
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  encryptionSecretKey: Uint8Array;
}

export interface WalletPublicInfo {
  signingPublicKey: string;
  encryptionPublicKey: string;
}

interface WalletFile {
  version: number;
  kdf: string;
  kdf_params: { N: number; r: number; p: number };
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

// N=2^14 for test compat; production should use N=2^17
const KDF_N = Number(process.env['VEIL_KDF_N'] ?? 16384);
const KDF_PARAMS = { N: KDF_N, r: 8, p: 1 };

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, KDF_PARAMS);
}

function encrypt(data: Buffer, password: string): { salt: string; iv: string; ciphertext: string; tag: string } {
  const salt = randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  };
}

function decrypt(enc: { salt: string; iv: string; ciphertext: string; tag: string }, password: string, kdfParams?: { N: number; r: number; p: number }): Buffer {
  const salt = Buffer.from(enc.salt, 'hex');
  const params = kdfParams ?? KDF_PARAMS;
  const key = scryptSync(password, salt, 32, params);
  const iv = Buffer.from(enc.iv, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'hex')),
    decipher.final(),
  ]);
}

function getVeilHome(veilHome?: string): string {
  return veilHome ?? join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.veil');
}

export async function createWallet(password: string, veilHome?: string): Promise<WalletPublicInfo> {
  const home = getVeilHome(veilHome);

  if (existsSync(join(home, 'wallet.json'))) {
    throw new Error('Already initialized. Use --force to reinitialize.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'data'), { recursive: true });

  const signing = generateSigningKeyPair();
  const encryption = generateEncryptionKeyPair();

  const keysJson = JSON.stringify({
    signingPublicKey: toHex(signing.publicKey),
    signingSecretKey: toHex(signing.secretKey),
    encryptionPublicKey: toHex(encryption.publicKey),
    encryptionSecretKey: toHex(encryption.secretKey),
  });

  const enc = encrypt(Buffer.from(keysJson, 'utf-8'), password);

  const walletFile: WalletFile = {
    version: 1,
    kdf: 'scrypt',
    kdf_params: { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p },
    ...enc,
  };

  writeFileSync(join(home, 'wallet.json'), JSON.stringify(walletFile, null, 2), { mode: 0o600 });

  const config = {
    relay_url: 'wss://relay-jp.runveil.io',
    gateway_port: 9960,
    consumer_pubkey: toHex(signing.publicKey),
    encryption_pubkey: toHex(encryption.publicKey),
  };

  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });

  return {
    signingPublicKey: toHex(signing.publicKey),
    encryptionPublicKey: toHex(encryption.publicKey),
  };
}

export async function loadWallet(password: string, veilHome?: string): Promise<Wallet> {
  const home = getVeilHome(veilHome);
  const walletPath = join(home, 'wallet.json');

  if (!existsSync(walletPath)) {
    throw new Error("Run 'veil init' first.");
  }

  const walletFile: WalletFile = JSON.parse(readFileSync(walletPath, 'utf-8'));
  const decrypted = decrypt(walletFile, password, walletFile.kdf_params);
  const keys = JSON.parse(decrypted.toString('utf-8'));

  return {
    signingPublicKey: fromHex(keys.signingPublicKey),
    signingSecretKey: fromHex(keys.signingSecretKey),
    encryptionPublicKey: fromHex(keys.encryptionPublicKey),
    encryptionSecretKey: fromHex(keys.encryptionSecretKey),
  };
}

export function getPublicKeys(veilHome?: string): WalletPublicInfo {
  const home = getVeilHome(veilHome);
  const configPath = join(home, 'config.json');

  if (!existsSync(configPath)) {
    throw new Error("Not initialized. Run 'veil init'.");
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return {
    signingPublicKey: config.consumer_pubkey,
    encryptionPublicKey: config.encryption_pubkey,
  };
}

export function encryptApiKey(
  apiKey: string,
  password: string,
): { salt: string; iv: string; ciphertext: string; tag: string } {
  return encrypt(Buffer.from(apiKey, 'utf-8'), password);
}

export function decryptApiKey(
  enc: { salt: string; iv: string; ciphertext: string; tag: string },
  password: string,
): string {
  return decrypt(enc, password).toString('utf-8');
}
