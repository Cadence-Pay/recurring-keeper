import { describe, expect, it } from 'vitest';
import { buildApi, type HealthInfo } from './api.js';
import { runChargeCycle } from './charger.js';
import { SqliteStore } from './store/sqlite.js';
import { syncOnce } from './sync.js';
import { FakeChain, MERCHANT, SUBSCRIBER } from './testing/fake-chain.js';

const OTHER_MERCHANT = SUBSCRIBER; // any other valid account address will do
const HEALTH: HealthInfo = {
  network: 'testnet',
  contractId: 'CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E',
  readOnly: false,
  lastSyncAt: 1234,
};

interface PageJson<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
interface PlanJson {
  id: number;
  merchant: string;
  token: string;
  amount: string;
  periodSecs: number;
  active: boolean;
}
interface SubJson {
  id: number;
  planId: number;
  subscriber: string;
  nextChargeTs: number;
  status: string;
  charges: number;
}
interface ChargeJson {
  id: number;
  subId: number;
  planId: number;
  dueTs: number;
  amount: string;
  status: string;
  txHash: string | null;
}
interface RevenueJson {
  merchant: string;
  asOf: number | null;
  lines: { token: string; total: string; payments: number }[];
}
interface ErrorJson {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

type App = ReturnType<typeof buildApi>;

/** GET a URL and parse the JSON body as `T` (the test states the expected shape). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function get<T>(app: App, url: string) {
  const res = await app.inject(url);
  return { status: res.statusCode, body: JSON.parse(res.body) as T, headers: res.headers };
}

/** Two merchants, three plans, three subscriptions, charged once or twice. */
async function seeded(corsOrigins: string[] = []) {
  const chain = new FakeChain();
  chain.now = 1_000_000;
  chain.addPlan({ amount: 10_000_000n }); // plan 1, MERCHANT
  chain.addPlan({ amount: 5n, merchant: OTHER_MERCHANT }); // plan 2
  chain.addPlan({ amount: 2n ** 100n }); // plan 3, MERCHANT, bigger than a JS number
  chain.addSub(1); // sub 1
  chain.addSub(1); // sub 2
  chain.addSub(3); // sub 3
  const store = new SqliteStore(':memory:');
  await syncOnce(chain, store);
  const clock = { t: 1_000_060 };
  chain.now = clock.t;
  const deps = { chain, store, now: () => clock.t };
  await runChargeCycle(deps); // every subscription charged once
  clock.t += 60;
  chain.now = clock.t;
  chain.cancelSub(2);
  chain.cancelSub(3);
  await runChargeCycle(deps); // only sub 1 is still active: charged a second time
  await syncOnce(chain, store);
  const app = buildApi({ store, corsOrigins, health: () => HEALTH });
  return { app, store, chain };
}

describe('GET /health', () => {
  it('reports status and configuration facts', async () => {
    const { app } = await seeded();
    const res = await get<Record<string, unknown>>(app, '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', ...HEALTH });
  });
});

describe('GET /plans', () => {
  it('lists all plans with a total', async () => {
    const { app } = await seeded();
    const { body } = await get<PageJson<PlanJson>>(app, '/plans');
    expect(body.total).toBe(3);
    expect(body.items.map((p) => p.id)).toEqual([1, 2, 3]);
    const { token, ...plan } = body.items[0] as PlanJson;
    expect(plan).toEqual({
      id: 1,
      merchant: MERCHANT,
      amount: '10000000',
      periodSecs: 60,
      active: true,
    });
    expect(token).toMatch(/^C[A-Z2-7]{55}$/);
    expect(body.limit).toBe(50);
  });

  it('filters by merchant', async () => {
    const { app } = await seeded();
    const { body } = await get<PageJson<PlanJson>>(app, `/plans?merchant=${OTHER_MERCHANT}`);
    expect(body.items.map((p) => p.id)).toEqual([2]);
    expect(body.total).toBe(1);
  });

  it('pages through results', async () => {
    const { app } = await seeded();
    const first = await get<PageJson<PlanJson>>(app, '/plans?limit=1&offset=1');
    expect(first.body.items.map((p) => p.id)).toEqual([2]);
    expect(first.body.total).toBe(3);
    expect((await get<PageJson<PlanJson>>(app, '/plans?limit=2&offset=2')).body.items).toHaveLength(
      1,
    );
    expect((await get<PageJson<PlanJson>>(app, '/plans?offset=10')).body.items).toEqual([]);
  });

  it('keeps a 128-bit amount exact', async () => {
    const { app } = await seeded();
    const { body } = await get<PageJson<PlanJson>>(app, '/plans');
    expect(body.items[2]?.amount).toBe((2n ** 100n).toString());
  });

  it('rejects bad input with a 400 and a typed body', async () => {
    const { app } = await seeded();
    const urls = [
      '/plans?merchant=nope',
      '/plans?limit=0',
      '/plans?limit=500',
      '/plans?offset=-1',
      '/plans?limit=abc',
    ];
    for (const url of urls) {
      const res = await get<ErrorJson>(app, url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details?.length).toBeGreaterThan(0);
    }
  });
});

describe('GET /plans/:id/subscriptions', () => {
  it('lists the subscriptions of a plan', async () => {
    const { app } = await seeded();
    const { body } = await get<PageJson<SubJson>>(app, '/plans/1/subscriptions');
    expect(body.total).toBe(2);
    const { nextChargeTs, ...sub } = body.items[0] as SubJson;
    expect(sub).toEqual({
      id: 1,
      planId: 1,
      subscriber: SUBSCRIBER,
      status: 'Active',
      charges: 2,
    });
    expect(Number.isInteger(nextChargeTs)).toBe(true);
    expect(body.items[1]?.status).toBe('Cancelled');
  });

  it('returns an empty page for a plan without subscribers', async () => {
    const { app } = await seeded();
    const { body } = await get<PageJson<SubJson>>(app, '/plans/2/subscriptions');
    expect(body).toMatchObject({ items: [], total: 0 });
  });

  it('answers 404 for an unknown plan and 400 for a bad id', async () => {
    const { app } = await seeded();
    const missing = await get<ErrorJson>(app, '/plans/99/subscriptions');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    for (const url of [
      '/plans/abc/subscriptions',
      '/plans/0/subscriptions',
      '/plans/1.5/subscriptions',
    ]) {
      expect((await get<ErrorJson>(app, url)).status, url).toBe(400);
    }
  });
});

describe('GET /subscriptions/:id/charges', () => {
  it('lists the charge records of a subscription', async () => {
    const { app } = await seeded();
    const { body } = await get<PageJson<ChargeJson>>(app, '/subscriptions/1/charges');
    expect(body.total).toBe(2);
    expect(body.items.map((c) => c.status)).toEqual(['succeeded', 'succeeded']);
    expect(body.items[0]).toMatchObject({ subId: 1, planId: 1, amount: '10000000' });
    expect(body.items.every((c) => typeof c.txHash === 'string')).toBe(true);
    expect(body.items[0]?.dueTs).toBeLessThan(body.items[1]?.dueTs ?? 0);
  });

  it('answers 404 for an unknown subscription and 400 for a bad id', async () => {
    const { app } = await seeded();
    expect((await get<ErrorJson>(app, '/subscriptions/99/charges')).status).toBe(404);
    expect((await get<ErrorJson>(app, '/subscriptions/x/charges')).status).toBe(400);
    expect((await get<ErrorJson>(app, '/subscriptions/1/charges?limit=0')).status).toBe(400);
  });
});

describe('GET /merchants/:address/revenue', () => {
  it('counts the first payment plus every charge, per token', async () => {
    const { app } = await seeded();
    const { body } = await get<RevenueJson>(app, `/merchants/${MERCHANT}/revenue`);
    // Sub 1: first payment + 2 charges of 10_000_000. Sub 2: first + 1 charge of 10_000_000.
    // Sub 3: first + 1 charge of 2^100.
    const expected = 10_000_000n * 5n + 2n ** 100n * 2n;
    expect(body).toMatchObject({ merchant: MERCHANT, asOf: 1234 });
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]?.total).toBe(expected.toString());
    expect(body.lines[0]?.payments).toBe(7);
  });

  it('returns no lines for a merchant without plans', async () => {
    const { app } = await seeded();
    const { body } = await get<RevenueJson>(
      app,
      `/merchants/${SUBSCRIBER.replace('GACJ', 'GBCJ')}/revenue`,
    );
    expect(body.lines).toEqual([]);
  });

  it('rejects an address that is not an account', async () => {
    const { app } = await seeded();
    expect((await get<ErrorJson>(app, '/merchants/not-an-address/revenue')).status).toBe(400);
  });
});

describe('errors and routing', () => {
  it('answers 404 with the same error shape for unknown routes', async () => {
    const { app } = await seeded();
    const res = await get<ErrorJson>(app, '/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No such route' } });
  });

  it('does not allow writes', async () => {
    const { app } = await seeded();
    expect((await app.inject({ method: 'POST', url: '/plans' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/plans/1' })).statusCode).toBe(404);
  });

  it('answers 500 without leaking the cause when the store fails', async () => {
    const { app, store } = await seeded();
    store.listPlans = () => Promise.reject(new Error('disk exploded at /secret/path'));
    const res = await get<ErrorJson>(app, '/plans');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('CORS', () => {
  it('allows a listed origin and answers its preflight', async () => {
    const { app } = await seeded(['https://dash.example.com']);
    const res = await app.inject({
      url: '/plans',
      headers: { origin: 'https://dash.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://dash.example.com');
    expect(res.headers['vary']).toBe('Origin');

    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/plans',
      headers: { origin: 'https://dash.example.com', 'access-control-request-method': 'GET' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
  });

  it('gives no CORS headers to an origin that is not listed', async () => {
    const { app } = await seeded(['https://dash.example.com']);
    const res = await app.inject({
      url: '/plans',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/plans',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(pre.statusCode).toBe(404);
  });

  it('allows any origin with *, and none by default', async () => {
    const star = await seeded(['*']);
    const any = await star.app.inject({ url: '/plans', headers: { origin: 'https://x.example' } });
    expect(any.headers['access-control-allow-origin']).toBe('*');
    const none = await seeded();
    const res = await none.app.inject({ url: '/plans', headers: { origin: 'https://x.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
