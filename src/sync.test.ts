import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RpcTimeoutError } from './errors.js';
import { DataRangeError, toPlanRecord, toSafeInt, toSubRecord } from './mappers.js';
import { SqliteStore } from './store/sqlite.js';
import { syncOnce } from './sync.js';
import { FakeChain, MERCHANT, SUBSCRIBER, TOKEN } from './testing/fake-chain.js';

function setup() {
  return { chain: new FakeChain(), store: new SqliteStore(':memory:') };
}

describe('syncOnce', () => {
  it('copies new plans and subscriptions into the store', async () => {
    const { chain, store } = setup();
    chain.addPlan();
    chain.addPlan({ amount: 5n });
    chain.addSub(1);
    const report = await syncOnce(chain, store);
    expect(report).toMatchObject({ newPlans: 2, newSubs: 1, problems: [] });
    expect(await store.getPlan(2)).toMatchObject({ amount: '5', merchant: MERCHANT, token: TOKEN });
    expect(await store.getSub(1)).toMatchObject({
      planId: 1,
      subscriber: SUBSCRIBER,
      status: 'Active',
    });
    expect(await store.getCursor('plans')).toBe(2);
    expect(await store.getCursor('subs')).toBe(1);
  });

  it('picks up items created after the first pass and does not re-copy old ones', async () => {
    const { chain, store } = setup();
    chain.addPlan();
    await syncOnce(chain, store);
    chain.addPlan();
    chain.addSub(2);
    const report = await syncOnce(chain, store);
    expect(report.newPlans).toBe(1);
    expect(report.newSubs).toBe(1);
    expect(report.refreshedPlans).toBe(1); // plan 1 was active and is read again
  });

  it('updates a cancelled subscription and a deactivated plan', async () => {
    const { chain, store } = setup();
    chain.addPlan();
    chain.addSub(1);
    await syncOnce(chain, store);
    chain.cancelSub(1);
    chain.deactivatePlan(1);
    const report = await syncOnce(chain, store);
    expect(report).toMatchObject({ refreshedPlans: 1, refreshedSubs: 1, problems: [] });
    expect((await store.getSub(1))?.status).toBe('Cancelled');
    expect((await store.getPlan(1))?.active).toBe(false);
    // Once inactive, they are no longer read again.
    const third = await syncOnce(chain, store);
    expect(third).toMatchObject({ refreshedPlans: 0, refreshedSubs: 0 });
  });

  it('picks up charges made on chain (charges and next charge time)', async () => {
    const { chain, store } = setup();
    chain.addPlan();
    chain.addSub(1);
    await syncOnce(chain, store);
    chain.now += 60;
    await chain.charge(1n);
    await syncOnce(chain, store);
    const sub = await store.getSub(1);
    expect(sub?.charges).toBe(1);
    expect(sub?.nextChargeTs).toBe(1_000_000 + 120);
  });

  it('is idempotent when nothing changed', async () => {
    const { chain, store } = setup();
    chain.addPlan();
    chain.addSub(1);
    await syncOnce(chain, store);
    const before = await store.getSub(1);
    const report = await syncOnce(chain, store);
    expect(report.newPlans + report.newSubs).toBe(0);
    expect(await store.getSub(1)).toEqual(before);
  });

  it('stops at a failing id without skipping it, and resumes from there', async () => {
    const { chain, store } = setup();
    for (let i = 0; i < 4; i++) chain.addPlan();
    chain.planFailures.set(3, new RpcTimeoutError('read plan 3', 1000));
    const first = await syncOnce(chain, store);
    expect(first.newPlans).toBe(2);
    expect(first.problems).toHaveLength(1);
    expect(first.problems[0]).toMatchObject({ kind: 'plan', id: 3 });
    expect(await store.getCursor('plans')).toBe(2);
    expect(await store.getPlan(4)).toBeUndefined(); // order preserved: 4 waits for 3

    chain.planFailures.clear();
    const second = await syncOnce(chain, store);
    expect(second.newPlans).toBe(2);
    expect(await store.getCursor('plans')).toBe(4);
    expect(second.problems).toEqual([]);
  });

  it('keeps refreshing other subscriptions when one refresh fails', async () => {
    const { chain, store } = setup();
    chain.addPlan();
    chain.addSub(1);
    chain.addSub(1);
    await syncOnce(chain, store);
    chain.subFailures.set(1, new Error('boom'));
    chain.now += 60;
    await chain.charge(2n);
    const report = await syncOnce(chain, store);
    expect(report.refreshedSubs).toBe(1);
    expect(report.problems).toEqual([{ kind: 'subscription', id: 1, message: 'boom' }]);
    expect((await store.getSub(2))?.charges).toBe(1);
  });

  it('rejects when the counts cannot be read', async () => {
    const { chain, store } = setup();
    chain.getPlanCount = () => Promise.reject(new RpcTimeoutError('read plan count', 10));
    await expect(syncOnce(chain, store)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('resumes after a restart using the database on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-sync-'));
    try {
      const path = join(dir, 'keeper.sqlite');
      const chain = new FakeChain();
      chain.addPlan();
      chain.addPlan();
      chain.addSub(1);
      const first = new SqliteStore(path);
      await syncOnce(chain, first);
      first.close();

      chain.addPlan();
      chain.addSub(3);
      const second = new SqliteStore(path); // restart
      const report = await syncOnce(chain, second);
      expect(report.newPlans).toBe(1);
      expect(report.newSubs).toBe(1);
      expect(await second.getCursor('plans')).toBe(3);
      expect(await second.getCursor('subs')).toBe(2);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The single element of a list, or a failure. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected one item');
  return item;
}

describe('mappers', () => {
  it('convert chain values to records', () => {
    const chain = new FakeChain();
    chain.addPlan({ amount: 123n, period_secs: 3600n });
    chain.addSub(1, { charges: 4 });
    expect(toPlanRecord(1n, only(chain.plans))).toMatchObject({
      id: 1,
      amount: '123',
      periodSecs: 3600,
    });
    expect(toSubRecord(1n, only(chain.subs))).toMatchObject({
      id: 1,
      planId: 1,
      charges: 4,
      status: 'Active',
    });
  });

  it('refuse integers that would lose precision', () => {
    expect(toSafeInt(5n, 'x')).toBe(5);
    expect(() => toSafeInt(2n ** 60n, 'x')).toThrow(DataRangeError);
    expect(() => toSafeInt(-1n, 'x')).toThrow(DataRangeError);
  });
});
