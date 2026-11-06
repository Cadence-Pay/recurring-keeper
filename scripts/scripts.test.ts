import { describe, expect, it } from 'vitest';
import { evaluateHealth, run as runHealth } from './check-health.js';
import { run as runWait, succeededHashes } from './wait-for-charge.js';

const NOW = 1_000_000;
const HEALTHY = {
  status: 'ok',
  network: 'testnet',
  contractId: 'CABC',
  readOnly: false,
  lastSyncAt: NOW - 10,
};
const OPTIONS = { maxAgeSecs: 90, expect: 'charging' } as const;

function respond(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function collector() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line) };
}

describe('evaluateHealth', () => {
  it('accepts a keeper that is charging and synced recently', () => {
    expect(evaluateHealth(HEALTHY, OPTIONS, NOW)).toEqual([]);
  });

  it('reports a sync that is too old, exactly at the limit but not before', () => {
    expect(evaluateHealth({ ...HEALTHY, lastSyncAt: NOW - 90 }, OPTIONS, NOW)).toEqual([]);
    expect(evaluateHealth({ ...HEALTHY, lastSyncAt: NOW - 91 }, OPTIONS, NOW)[0]).toContain(
      '91 s ago',
    );
  });

  it('reports a keeper that has never synced', () => {
    expect(evaluateHealth({ ...HEALTHY, lastSyncAt: null }, OPTIONS, NOW)[0]).toContain(
      'not finished a sync',
    );
  });

  it('reports a read-only keeper that is expected to charge, and the reverse', () => {
    expect(evaluateHealth({ ...HEALTHY, readOnly: true }, OPTIONS, NOW)[0]).toContain('read only');
    expect(evaluateHealth(HEALTHY, { ...OPTIONS, expect: 'readonly' }, NOW)[0]).toContain(
      'can submit',
    );
    expect(
      evaluateHealth({ ...HEALTHY, readOnly: true }, { ...OPTIONS, expect: 'any' }, NOW),
    ).toEqual([]);
  });

  it('reports an answer in the wrong shape', () => {
    expect(evaluateHealth({ status: 'ok' }, OPTIONS, NOW)[0]).toContain('documented shape');
    expect(evaluateHealth('nope', OPTIONS, NOW)).toHaveLength(1);
  });

  it('reports every problem at once', () => {
    expect(
      evaluateHealth({ ...HEALTHY, readOnly: true, lastSyncAt: null }, OPTIONS, NOW),
    ).toHaveLength(2);
  });
});

describe('check-health run', () => {
  const base = ['--url', 'http://keeper.test:8080'];

  it('exits 0 and says healthy', async () => {
    const { lines, out } = collector();
    expect(await runHealth(base, { fetch: respond(200, HEALTHY), now: () => NOW, out })).toBe(0);
    expect(lines).toEqual(['healthy']);
  });

  it('exits 1 with the problems when unhealthy', async () => {
    const { lines, out } = collector();
    const stale = { ...HEALTHY, lastSyncAt: NOW - 500 };
    expect(await runHealth(base, { fetch: respond(200, stale), now: () => NOW, out })).toBe(1);
    expect(lines[0]).toContain('UNHEALTHY');
  });

  it('exits 1 when the keeper does not answer or answers with an error status', async () => {
    const down = (() => Promise.reject(new TypeError('connect refused'))) as typeof fetch;
    const a = collector();
    expect(await runHealth(base, { fetch: down, now: () => NOW, out: a.out })).toBe(1);
    expect(a.lines[0]).toContain('did not answer');
    const b = collector();
    expect(await runHealth(base, { fetch: respond(500, {}), now: () => NOW, out: b.out })).toBe(1);
    expect(b.lines[0]).toContain('HTTP 500');
  });

  it('exits 2 on bad usage and never calls the network', async () => {
    let called = false;
    const spy = (() => {
      called = true;
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    for (const argv of [
      [],
      ['--url'],
      ['--url', 'nonsense'],
      [...base, '--expect', 'sometimes'],
      [...base, '--max-age-secs', '0'],
    ]) {
      const { out } = collector();
      expect(await runHealth(argv, { fetch: spy, now: () => NOW, out })).toBe(2);
    }
    expect(called).toBe(false);
  });
});

describe('succeededHashes', () => {
  it('lists only succeeded charges that have a hash', () => {
    const body = {
      total: 3,
      items: [
        { status: 'succeeded', txHash: 'aa', dueTs: 1 },
        { status: 'failed', txHash: null, dueTs: 2 },
        { status: 'succeeded', txHash: 'bb', dueTs: 3 },
        { status: 'pending', txHash: 'cc', dueTs: 4 },
      ],
    };
    expect(succeededHashes(body)).toEqual(['aa', 'bb']);
  });

  it('gives nothing for an answer in the wrong shape', () => {
    expect(succeededHashes({ nope: true })).toEqual([]);
  });
});

describe('wait-for-charge run', () => {
  const argv = [
    '--url',
    'http://keeper.test',
    '--sub',
    '2',
    '--count',
    '2',
    '--timeout-secs',
    '60',
  ];
  const charges = (n: number) => ({
    total: n,
    items: Array.from({ length: n }, (_, i) => ({
      status: 'succeeded',
      txHash: `hash${String(i + 1)}`,
      dueTs: i,
    })),
  });

  it('returns 0 and prints the hashes once enough charges succeeded', async () => {
    const { lines, out } = collector();
    let call = 0;
    const fetchImpl = (() => {
      call++;
      return Promise.resolve(new Response(JSON.stringify(charges(call < 3 ? 1 : 2))));
    }) as typeof fetch;
    let clock = 0;
    const code = await runWait(argv, {
      fetch: fetchImpl,
      sleep: () => {
        clock += 5000;
        return Promise.resolve();
      },
      now: () => clock,
      out,
    });
    expect(code).toBe(0);
    expect(lines).toEqual(['2 charge(s) succeeded', 'CHARGE_TX=hash1', 'CHARGE_TX=hash2']);
  });

  it('keeps waiting through errors from the keeper and gives up at the deadline', async () => {
    const { lines, out } = collector();
    let clock = 0;
    const code = await runWait(argv, {
      fetch: () => Promise.reject(new TypeError('down')),
      sleep: () => {
        clock += 20_000;
        return Promise.resolve();
      },
      now: () => clock,
      out,
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain('TIMEOUT');
  });

  it('exits 2 on bad usage', async () => {
    for (const bad of [
      [],
      ['--url', 'http://k'],
      ['--url', 'http://k', '--sub', '0'],
      [...argv, '--count', '0'],
    ]) {
      const { out } = collector();
      const code = await runWait(bad, { fetch, sleep: () => Promise.resolve(), now: () => 0, out });
      expect(code).toBe(2);
    }
  });
});
