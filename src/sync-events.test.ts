import { describe, expect, it } from 'vitest';
import type { EventSink, KeeperEvent } from './events.js';
import { SqliteStore } from './store/sqlite.js';
import { syncOnce } from './sync.js';
import { FakeChain, MERCHANT, SUBSCRIBER } from './testing/fake-chain.js';

function collector() {
  const events: KeeperEvent[] = [];
  const sink: EventSink = {
    emit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  return { events, sink };
}

describe('events from syncOnce', () => {
  it('does not replay history on the very first pass', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    chain.addSub(1);
    chain.addSub(1, { status: { tag: 'Cancelled', values: undefined } });
    const store = new SqliteStore(':memory:');
    const { events, sink } = collector();
    await syncOnce(chain, store, { sink });
    expect(events).toEqual([]);
    expect(await store.getCursor('bootstrap')).toBe(1);
  });

  it('announces a subscription created after the first pass', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    const store = new SqliteStore(':memory:');
    const { events, sink } = collector();
    await syncOnce(chain, store, { sink, now: () => 77 });
    chain.addSub(1);
    await syncOnce(chain, store, { sink, now: () => 77 });
    expect(events).toEqual([
      {
        type: 'subscription.created',
        merchant: MERCHANT,
        planId: 1,
        subId: 1,
        subscriber: SUBSCRIBER,
        occurredAt: 77,
      },
    ]);
  });

  it('works even when the first pass found nothing at all', async () => {
    const chain = new FakeChain();
    const store = new SqliteStore(':memory:');
    const { events, sink } = collector();
    await syncOnce(chain, store, { sink }); // empty chain
    chain.addPlan();
    chain.addSub(1);
    await syncOnce(chain, store, { sink });
    expect(events.map((e) => e.type)).toEqual(['subscription.created']);
  });

  it('announces a cancellation once, when an active subscription becomes cancelled', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    chain.addSub(1);
    const store = new SqliteStore(':memory:');
    const { events, sink } = collector();
    await syncOnce(chain, store, { sink });
    chain.cancelSub(1);
    await syncOnce(chain, store, { sink });
    await syncOnce(chain, store, { sink });
    expect(events.map((e) => e.type)).toEqual(['subscription.cancelled']);
  });

  it('announces both events for a subscription created and cancelled between passes', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    const store = new SqliteStore(':memory:');
    const { events, sink } = collector();
    await syncOnce(chain, store, { sink });
    chain.addSub(1, { status: { tag: 'Cancelled', values: undefined } });
    await syncOnce(chain, store, { sink });
    expect(events.map((e) => e.type)).toEqual(['subscription.created', 'subscription.cancelled']);
  });

  it('keeps syncing when the sink throws', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    const store = new SqliteStore(':memory:');
    const sink: EventSink = { emit: () => Promise.reject(new Error('queue full')) };
    await syncOnce(chain, store, { sink });
    chain.addSub(1);
    const report = await syncOnce(chain, store, { sink });
    expect(report.newSubs).toBe(1);
    expect(report.problems).toEqual([]);
    expect(await store.getSub(1)).toBeDefined();
  });

  it('does not mark the first pass as done when it had problems', async () => {
    const chain = new FakeChain();
    chain.addPlan();
    chain.planFailures.set(1, new Error('boom'));
    const store = new SqliteStore(':memory:');
    await syncOnce(chain, store);
    expect(await store.getCursor('bootstrap')).toBe(0);
  });
});
