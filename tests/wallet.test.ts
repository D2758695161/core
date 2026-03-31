import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWallet, loadWallet, getPublicKeys } from '../src/wallet/index.js';

describe('wallet', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('createWallet creates wallet.json + config.json', async () => {
    const info = await createWallet('testpassword123', tempDir);
    expect(existsSync(join(tempDir, 'wallet.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'config.json'))).toBe(true);
    expect(info.signingPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(info.encryptionPublicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loadWallet with correct password returns keys', async () => {
    const info = await createWallet('testpassword123', tempDir);
    const wallet = await loadWallet('testpassword123', tempDir);
    expect(wallet.signingPublicKey.length).toBe(32);
    expect(wallet.signingSecretKey.length).toBe(64);
    expect(wallet.encryptionPublicKey.length).toBe(32);
    expect(wallet.encryptionSecretKey.length).toBe(32);
  });

  it('loadWallet with wrong password throws', async () => {
    await createWallet('testpassword123', tempDir);
    await expect(loadWallet('wrongpassword!', tempDir)).rejects.toThrow();
  });

  it('getPublicKeys reads without password', async () => {
    const info = await createWallet('testpassword123', tempDir);
    const keys = getPublicKeys(tempDir);
    expect(keys.signingPublicKey).toBe(info.signingPublicKey);
    expect(keys.encryptionPublicKey).toBe(info.encryptionPublicKey);
  });

  it('createWallet on existing dir throws', async () => {
    await createWallet('testpassword123', tempDir);
    await expect(createWallet('testpassword123', tempDir)).rejects.toThrow(/Already initialized/);
  });
});
