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

const MERCHANT = 'GAIPBT4WCBUALPT77TFYIK4LAHN67QNFM4OOTX3VEH4L6URNOUFJOTSQ';

function hooks(entry: Record<string, unknown>): Record<string, string> {
  return { ...baseEnv(), WEBHOOK_CONFIG: JSON.stringify({ [MERCHANT]: entry }) };
}

describe('webhook configuration', () => {
  it('is empty when not set', () => {
    expect(loadConfig(baseEnv()).webhooks).toEqual({});
  });

  it('reads the endpoint and takes the secret from the named variable', () => {
    const config = loadConfig({
      ...hooks({ url: 'https://hooks.example.com/x', secretEnv: 'HOOK_SECRET_A' }),
      HOOK_SECRET_A: 'a-long-enough-secret-value',
    });
    expect(config.webhooks[MERCHANT]).toEqual({
      url: 'https://hooks.example.com/x',
      secret: 'a-long-enough-secret-value',
    });
  });

  it('allows plain http only for localhost', () => {
    const env = { HOOK_SECRET_A: 'a-long-enough-secret-value' };
    expect(
      loadConfig({
        ...hooks({ url: 'http://localhost:9000/x', secretEnv: 'HOOK_SECRET_A' }),
        ...env,
      }).webhooks[MERCHANT]?.url,
    ).toBe('http://localhost:9000/x');
    expect(() =>
      loadConfig({ ...hooks({ url: 'http://example.com/x', secretEnv: 'HOOK_SECRET_A' }), ...env }),
    ).toThrow(/must use https/);
  });

  it('rejects a missing or short secret without repeating it', () => {
    const entry = { url: 'https://hooks.example.com/x', secretEnv: 'HOOK_SECRET_A' };
    expect(() => loadConfig(hooks(entry))).toThrow(/HOOK_SECRET_A/);
    try {
      loadConfig({ ...hooks(entry), HOOK_SECRET_A: 'short' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('at least 16');
      expect((error as Error).message).not.toContain('short');
    }
  });

  it('rejects invalid JSON, bad merchant addresses and bad variable names', () => {
    expect(() => loadConfig({ ...baseEnv(), WEBHOOK_CONFIG: '{not json' })).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      loadConfig({
        ...baseEnv(),
        WEBHOOK_CONFIG: JSON.stringify({ GNOPE: { url: 'https://a.example', secretEnv: 'X_Y' } }),
      }),
    ).toThrow(/WEBHOOK_CONFIG/);
    expect(() =>
      loadConfig(hooks({ url: 'https://hooks.example.com/x', secretEnv: 'lower-case' })),
    ).toThrow(/environment variable name/);
  });

  it('keeps webhook secrets out of describeConfig', () => {
    const config = loadConfig({
      ...hooks({ url: 'https://hooks.example.com/x', secretEnv: 'HOOK_SECRET_A' }),
      HOOK_SECRET_A: 'a-long-enough-secret-value',
    });
    const text = JSON.stringify(describeConfig(config));
    expect(text).not.toContain('a-long-enough-secret-value');
    expect(text).toContain('"webhookMerchants":1');
  });
});
