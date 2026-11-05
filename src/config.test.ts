import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from './config.js';
import { ConfigError } from './errors.js';

const CONTRACT = 'CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E';
const TESTNET = 'Test SDF Network ; September 2015';

function baseEnv(): Record<string, string> {
  return {
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: TESTNET,
    CONTRACT_ID: CONTRACT,
  };
}

describe('loadConfig', () => {
  it('reads a valid read-only configuration with defaults', () => {
    const config = loadConfig(baseEnv());
    expect(config).toMatchObject({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      contractId: CONTRACT,
      readOnly: true,
      rpcTimeoutMs: 15_000,
      txTimeoutMs: 60_000,
    });
    expect(config.keeperSecretKey).toBeUndefined();
  });

  it('is not read only when a key is set', () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({ ...baseEnv(), KEEPER_SECRET_KEY: secret });
    expect(config.readOnly).toBe(false);
    expect(config.keeperSecretKey).toBe(secret);
  });

  it('stays read only when READ_ONLY is true even with a key', () => {
    const config = loadConfig({
      ...baseEnv(),
      KEEPER_SECRET_KEY: Keypair.random().secret(),
      READ_ONLY: 'true',
    });
    expect(config.readOnly).toBe(true);
  });

  it('treats empty values like unset values', () => {
    const config = loadConfig({ ...baseEnv(), KEEPER_SECRET_KEY: '', RPC_TIMEOUT_MS: '' });
    expect(config.readOnly).toBe(true);
    expect(config.rpcTimeoutMs).toBe(15_000);
  });

  it('accepts a custom timeout', () => {
    expect(loadConfig({ ...baseEnv(), RPC_TIMEOUT_MS: '5000' }).rpcTimeoutMs).toBe(5000);
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      const message = (error as Error).message;
      for (const name of [
        'STELLAR_NETWORK',
        'STELLAR_RPC_URL',
        'STELLAR_NETWORK_PASSPHRASE',
        'CONTRACT_ID',
      ]) {
        expect(message).toContain(name);
      }
    }
  });

  it('rejects an invalid contract id and a non-http RPC url', () => {
    expect(() => loadConfig({ ...baseEnv(), CONTRACT_ID: 'GABC' })).toThrow(/CONTRACT_ID/);
    expect(() => loadConfig({ ...baseEnv(), STELLAR_RPC_URL: 'ftp://example.org' })).toThrow(
      /STELLAR_RPC_URL/,
    );
  });

  it('rejects a timeout outside the allowed range', () => {
    expect(() => loadConfig({ ...baseEnv(), RPC_TIMEOUT_MS: '10' })).toThrow(/RPC_TIMEOUT_MS/);
  });

  it('rejects a passphrase that does not match the named network', () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
      }),
    ).toThrow(/does not match/);
  });

  it('allows a custom network name with its own passphrase', () => {
    const config = loadConfig({
      ...baseEnv(),
      STELLAR_NETWORK: 'local',
      STELLAR_NETWORK_PASSPHRASE: 'Standalone Network ; February 2017',
    });
    expect(config.network).toBe('local');
  });

  it('never repeats a bad secret key in the error message', () => {
    const bad = 'SNOTAREALKEY-this-text-must-not-appear';
    try {
      loadConfig({ ...baseEnv(), KEEPER_SECRET_KEY: bad });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('KEEPER_SECRET_KEY');
      expect((error as Error).message).not.toContain(bad);
    }
  });
});

describe('describeConfig', () => {
  it('hides the secret key', () => {
    const secret = Keypair.random().secret();
    const text = JSON.stringify(
      describeConfig(loadConfig({ ...baseEnv(), KEEPER_SECRET_KEY: secret })),
    );
    expect(text).not.toContain(secret);
    expect(text).toContain('"keeperSecretKey":"set"');
  });

  it('says unset when there is no key', () => {
    expect(describeConfig(loadConfig(baseEnv())).keeperSecretKey).toBe('unset');
  });
});
