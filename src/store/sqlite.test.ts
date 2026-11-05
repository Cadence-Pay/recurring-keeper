import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite.js';
import type { PlanRecord, SubRecord } from './types.js';

const PLAN: PlanRecord = {
  id: 1,
  merchant: 'GMERCHANT',
  token: 'CTOKEN',
  amount: '170141183460469231731687303715884105727', // i128::MAX does not fit a JS number
  periodSecs: 60,
  active: true,
};

const SUB: SubRecord = {
  id: 1,
  planId: 1,
  subscriber: 'GSUB',
  nextChargeTs: 1000,
  status: 'Active',
  charges: 0,
};

const open: SqliteStore[] = [];
function memory(): SqliteStore {
  const store = new SqliteStore(':memory:', () => 42);
  open.push(store);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
});

describe('SqliteStore cursors', () => {
  it('start at zero and remember what was set', async () => {
    const store = memory();
    expect(await store.getCursor('plans')).toBe(0);
    await store.setCursor('plans', 3);
    await store.setCursor('plans', 5);
    await store.setCursor('subs', 2);
    expect(await store.getCursor('plans')).toBe(5);
    expect(await store.getCursor('subs')).toBe(2);
  });
});

describe('SqliteStore plans and subscriptions', () => {
  it('store and read back a plan, keeping a 128-bit amount exact', async () => {
    const store = memory();
    await store.upsertPlan(PLAN);
    expect(await store.getPlan(1)).toEqual(PLAN);
  });

  it('replace a plan on upsert', async () => {
    const store = memory();
    await store.upsertPlan(PLAN);
    await store.upsertPlan({ ...PLAN, active: false });
    expect((await store.getPlan(1))?.active).toBe(false);
  });

  it('return undefined for unknown ids', async () => {
    const store = memory();
    expect(await store.getPlan(9)).toBeUndefined();
    expect(await store.getSub(9)).toBeUndefined();
  });

  it('store and update a subscription', async () => {
    const store = memory();
    await store.upsertSub(SUB);
    await store.upsertSub({ ...SUB, status: 'Cancelled', charges: 2 });
    expect(await store.getSub(1)).toEqual({ ...SUB, status: 'Cancelled', charges: 2 });
  });

  it('list only active plans and active subscriptions', async () => {
    const store = memory();
    await store.upsertPlan(PLAN);
    await store.upsertPlan({ ...PLAN, id: 2, active: false });
    await store.upsertSub(SUB);
    await store.upsertSub({ ...SUB, id: 2, status: 'Cancelled' });
    await store.upsertSub({ ...SUB, id: 3 });
    expect(await store.listActivePlanIds()).toEqual([1]);
    expect(await store.listActiveSubIds()).toEqual([1, 3]);
  });

  it('list due subscriptions, oldest first, skipping cancelled and future ones', async () => {
    const store = memory();
    await store.upsertSub({ ...SUB, id: 1, nextChargeTs: 300 });
    await store.upsertSub({ ...SUB, id: 2, nextChargeTs: 100 });
    await store.upsertSub({ ...SUB, id: 3, nextChargeTs: 200, status: 'Cancelled' });
    await store.upsertSub({ ...SUB, id: 4, nextChargeTs: 900 });
    const due = await store.listDueSubs(500, 10);
    expect(due.map((s) => s.id)).toEqual([2, 1]);
    expect((await store.listDueSubs(500, 1)).map((s) => s.id)).toEqual([2]);
    expect(await store.listDueSubs(50, 10)).toEqual([]);
  });
});

describe('SqliteStore on disk', () => {
  it('keeps data and cursors after closing and reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-store-'));
    try {
      const path = join(dir, 'keeper.sqlite');
      const first = new SqliteStore(path);
      await first.upsertPlan(PLAN);
      await first.setCursor('plans', 1);
      first.close();

      const second = new SqliteStore(path);
      expect(await second.getPlan(1)).toEqual(PLAN);
      expect(await second.getCursor('plans')).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails to open a path that cannot be created', () => {
    expect(() => new SqliteStore(join(tmpdir(), 'no-such-dir-keeper', 'x', 'db.sqlite'))).toThrow();
  });
});
