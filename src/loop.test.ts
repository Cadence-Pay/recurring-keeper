import { describe, expect, it } from 'vitest';
import { RpcTimeoutError } from './errors.js';
import type { Logger } from './logger.js';
import { abortableSleep, runKeeperLoop } from './loop.js';
import { SqliteStore } from './store/sqlite.js';
import { FakeChain } from './testing/fake-chain.js';

function collectingLogger() {
  const lines: { level: string; message: string }[] = [];
  const logger: Logger = {
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  };
  return { logger, lines };
}

describe('runKeeperLoop', () => {
  it('syncs and charges on each pass until aborted', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    chain.addSub(1);
    chain.now = 1_000_060;
    const store = new SqliteStore(':memory:');
    const controller = new AbortController();
    let sleeps = 0;
    await runKeeperLoop({
      chain,
      store,
      now: () => chain.now,
      intervalMs: 10,
      signal: controller.signal,
      sleep: () => {
        sleeps++;
        if (sleeps === 2) controller.abort();
        chain.now += 60; // time passes between passes
        return Promise.resolve();
      },
    });
    expect(sleeps).toBe(2);
    // Pass 1 charged the first period; pass 2 charged the next one.
    expect(chain.chargeCalls).toEqual([1n, 1n]);
    expect((await store.getSub(1))?.charges).toBe(2);
  });

  it('does not run at all if already aborted', async () => {
    const chain = new FakeChain();
    const controller = new AbortController();
    controller.abort();
    await runKeeperLoop({
      chain,
      store: new SqliteStore(':memory:'),
      intervalMs: 10,
      signal: controller.signal,
    });
    expect(chain.chargeCalls).toEqual([]);
  });

  it('logs a failed pass and carries on with the next one', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    let calls = 0;
    const original = chain.getPlanCount.bind(chain);
    chain.getPlanCount = () => {
      calls++;
      return calls === 1 ? Promise.reject(new RpcTimeoutError('read plan count', 5)) : original();
    };
    const { logger, lines } = collectingLogger();
    const store = new SqliteStore(':memory:');
    const controller = new AbortController();
    let sleeps = 0;
    await runKeeperLoop({
      chain,
      store,
      logger,
      intervalMs: 10,
      signal: controller.signal,
      sleep: () => {
        if (++sleeps === 2) controller.abort();
        return Promise.resolve();
      },
    });
    expect(lines.some((l) => l.level === 'error' && l.message === 'keeper pass failed')).toBe(true);
    expect(await store.getPlan(1)).toBeDefined(); // the second pass worked
  });
});

describe('abortableSleep', () => {
  it('ends early when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns at once if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await abortableSleep(10_000, controller.signal);
  });

  it('waits for the time when not aborted', async () => {
    const started = Date.now();
    await abortableSleep(30, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
