import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { silentLogger } from './logger.js';
import { createKeeper, main } from './main.js';
import { SqliteStore } from './store/sqlite.js';
import { FakeChain, MERCHANT } from './testing/fake-chain.js';

const SECRET = 'a-long-enough-webhook-secret';

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    CONTRACT_ID: 'CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E',
    DB_PATH: ':memory:',
    API_PORT: '0',
    CORS_ORIGINS: 'https://dash.example.com',
    WEBHOOK_CONFIG: JSON.stringify({
      [MERCHANT]: { url: 'https://hooks.example.com/in', secretEnv: 'HOOK_SECRET' },
    }),
    HOOK_SECRET: SECRET,
    ...extra,
  };
}

describe('createKeeper', () => {
  it('syncs, charges what is due, delivers a signed webhook and shuts down cleanly', async () => {
    const chain = new FakeChain();
    chain.now = 1_000_000;
    chain.addPlan({ period_secs: 60n });
    chain.addSub(1); // due at 1_000_060
    const store = new SqliteStore(':memory:');
    const clock = { t: 1_000_000 };
    const posted: { body: string; signature: string; event: string }[] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      posted.push({
        body: init.body as string,
        signature: headers['x-recurring-signature'] ?? '',
        event: headers['x-recurring-event'] ?? '',
      });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;

    const healthSeen: unknown[] = [];
    const controller = new AbortController();
    let sleeps = 0;
    const keeper = createKeeper(loadConfig(env()), {
      chain,
      store,
      fetch: fetchImpl,
      logger: silentLogger,
      now: () => clock.t,
      sleep: async () => {
        sleeps++;
        healthSeen.push((await keeper.app.inject('/health')).json());
        clock.t = 1_000_060;
        chain.now = 1_000_060;
        if (sleeps === 2) controller.abort();
      },
    });

    await keeper.run(controller.signal);

    expect(sleeps).toBe(2);
    // After pass 1 the API already reports a finished sync; the keeper is signing-less here.
    expect(healthSeen[0]).toMatchObject({
      status: 'ok',
      network: 'testnet',
      readOnly: true,
      lastSyncAt: 1_000_000,
    });
    // Pass 2 found the subscription due and charged it on chain.
    expect(chain.chargeCalls).toEqual([1n]);
    // The merchant got exactly one signed charge.succeeded webhook.
    expect(posted.map((p) => p.event)).toEqual(['charge.succeeded']);
    const request = posted[0];
    const expected = `sha256=${createHmac('sha256', SECRET)
      .update(request?.body ?? '')
      .digest('hex')}`;
    expect(request?.signature).toBe(expected);
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      type: 'charge.succeeded',
      data: { merchant: MERCHANT, subId: 1, amount: '10000000' },
    });
    // After shutdown the database is closed.
    expect(() => {
      store.close();
    }).toThrow();
  });
});

describe('main', () => {
  it('exits with code 2 and a readable message on bad configuration', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const code = await main({ STELLAR_NETWORK: 'testnet' });
      expect(code).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(written.join('')).toContain('Invalid configuration');
    expect(written.join('')).toContain('CONTRACT_ID');
  });
});
