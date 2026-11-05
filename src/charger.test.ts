import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, runChargeCycle, type ChargePolicy } from './charger.js';
import type { EventSink, KeeperEvent } from './events.js';
import { ReadOnlyError, RpcTimeoutError, SimulationError, SubmissionError } from './errors.js';
import type { Logger } from './logger.js';
import { SqliteStore } from './store/sqlite.js';
import { syncOnce } from './sync.js';
import { FakeChain } from './testing/fake-chain.js';

const START = 1_000_000;
const PERIOD = 60;

/** A chain with one plan and `subs` subscriptions, a store that has synced them, and a clock. */
async function setup(subs = 1, policy: Partial<ChargePolicy> = {}) {
  const chain = new FakeChain();
  chain.now = START;
  chain.addPlan({ period_secs: BigInt(PERIOD) });
  for (let i = 0; i < subs; i++) chain.addSub(1);
  const store = new SqliteStore(':memory:');
  await syncOnce(chain, store);
  const events: KeeperEvent[] = [];
  const sink: EventSink = {
    emit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  const clock = { t: START + PERIOD };
  chain.now = clock.t; // the first period has passed
  const deps = {
    chain,
    store,
    sink,
    now: () => clock.t,
    policy: { ...DEFAULT_POLICY, ...policy },
  };
  const advance = (secs: number) => {
    clock.t += secs;
    chain.now = clock.t;
  };
  return { chain, store, events, clock, deps, advance };
}

const paymentFailed = () => new SimulationError('charge', new Error('Error(Contract, #10)'));

describe('runChargeCycle', () => {
  it('charges a due subscription, records it, emits an event and refreshes the schedule', async () => {
    const { chain, store, events, deps } = await setup();
    const report = await runChargeCycle(deps);
    expect(report).toMatchObject({ due: 1, charged: 1, failed: 0, retryScheduled: 0 });
    expect(chain.chargeCalls).toEqual([1n]);

    const record = await store.getCharge(1, START + PERIOD);
    expect(record).toMatchObject({ status: 'succeeded', txHash: 'tx1', attempts: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'charge.succeeded',
      subId: 1,
      planId: 1,
      amount: '10000000',
      txHash: 'tx1',
    });
    const sub = await store.getSub(1);
    expect(sub?.charges).toBe(1);
    expect(sub?.nextChargeTs).toBe(START + 2 * PERIOD);
  });

  it('does not charge again in the next cycle once the schedule moved', async () => {
    const { chain, deps } = await setup();
    await runChargeCycle(deps);
    const second = await runChargeCycle(deps);
    expect(second.due).toBe(0);
    expect(chain.chargeCalls).toHaveLength(1);
  });

  it('does nothing when nothing is due', async () => {
    const { chain, deps, clock } = await setup();
    clock.t = START; // before the first due time
    const report = await runChargeCycle(deps);
    expect(report).toMatchObject({ due: 0, charged: 0 });
    expect(chain.chargeCalls).toEqual([]);
  });

  it('charges several due subscriptions one after another', async () => {
    const { chain, deps } = await setup(3);
    const report = await runChargeCycle(deps);
    expect(report.charged).toBe(3);
    expect(chain.chargeCalls).toEqual([1n, 2n, 3n]);
  });

  it('handles at most batchSize subscriptions per cycle', async () => {
    const { chain, deps } = await setup(3, { batchSize: 2 });
    expect((await runChargeCycle(deps)).charged).toBe(2);
    expect((await runChargeCycle(deps)).charged).toBe(1);
    expect(chain.chargeCalls).toHaveLength(3);
  });

  it('records a failed attempt (insufficient allowance), keeps going, and retries after the wait', async () => {
    const { chain, store, events, deps, advance } = await setup();
    chain.chargeFailure = paymentFailed();
    const first = await runChargeCycle(deps);
    expect(first).toMatchObject({ charged: 0, retryScheduled: 1, failed: 0 });
    const record = await store.getCharge(1, START + PERIOD);
    expect(record).toMatchObject({
      status: 'pending',
      attempts: 1,
      errorCode: 'PaymentFailed',
      nextAttemptAt: START + PERIOD + 30,
    });
    expect(events).toEqual([]);

    // Too early to retry: left alone.
    expect((await runChargeCycle(deps)).skipped).toBe(1);
    expect(chain.chargeCalls).toHaveLength(1);

    // Once the allowance is fixed, the retry succeeds.
    chain.chargeFailure = undefined;
    advance(30);
    const retry = await runChargeCycle(deps);
    expect(retry.charged).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['charge.succeeded']);
  });

  it('backs off 30, 60, 120, 240 seconds, then gives up with exactly one charge.failed event', async () => {
    const { chain, store, events, deps, advance } = await setup();
    chain.chargeFailure = paymentFailed();
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      await runChargeCycle(deps);
      const record = await store.getCharge(1, START + PERIOD);
      if (attempt < 5) {
        expect(record?.attempts).toBe(attempt);
        const wait = (record?.nextAttemptAt ?? 0) - deps.now();
        waits.push(wait);
        advance(wait);
      }
    }
    expect(waits).toEqual([30, 60, 120, 240]);

    const record = await store.getCharge(1, START + PERIOD);
    expect(record).toMatchObject({ status: 'failed', attempts: 5, errorCode: 'PaymentFailed' });
    const failures = events.filter((e) => e.type === 'charge.failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempts: 5, errorCode: 'PaymentFailed', subId: 1 });
    expect(chain.chargeCalls).toHaveLength(5);

    // While the cooldown lasts, nothing is submitted and no more events appear.
    advance(60);
    await runChargeCycle(deps);
    expect(chain.chargeCalls).toHaveLength(5);
    expect(events.filter((e) => e.type === 'charge.failed')).toHaveLength(1);
  });

  it('caps the wait at backoffMaxSecs', async () => {
    const { chain, store, deps, advance } = await setup(1, { backoffMaxSecs: 40, maxAttempts: 6 });
    chain.chargeFailure = paymentFailed();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await runChargeCycle(deps);
      const wait = ((await store.getCharge(1, START + PERIOD))?.nextAttemptAt ?? 0) - deps.now();
      waits.push(wait);
      advance(wait);
    }
    expect(waits).toEqual([30, 40, 40, 40]);
  });

  it('starts a new round after the cooldown and charges once the cause is fixed', async () => {
    const { chain, store, events, deps, advance } = await setup(1, { maxAttempts: 2 });
    chain.chargeFailure = paymentFailed();
    await runChargeCycle(deps);
    advance(30);
    await runChargeCycle(deps);
    expect((await store.getCharge(1, START + PERIOD))?.status).toBe('failed');

    chain.chargeFailure = undefined; // the subscriber renewed the allowance
    advance(DEFAULT_POLICY.failedCooldownSecs);
    const report = await runChargeCycle(deps);
    expect(report.charged).toBe(1);
    expect((await store.getCharge(1, START + PERIOD))?.status).toBe('succeeded');
    expect(events.map((e) => e.type)).toEqual(['charge.failed', 'charge.succeeded']);
  });

  it('treats an RPC timeout and a submission error as retryable failures', async () => {
    const { chain, store, deps, advance } = await setup(2);
    chain.chargeFailureQueue.set(1, [new RpcTimeoutError('submit charge', 5)]);
    chain.chargeFailureQueue.set(2, [new SubmissionError('charge', new Error('txBadSeq'))]);
    const first = await runChargeCycle(deps);
    expect(first).toMatchObject({ charged: 0, retryScheduled: 2 });
    expect((await store.getCharge(1, START + PERIOD))?.errorCode).toBe('RPC_TIMEOUT');
    expect((await store.getCharge(2, START + PERIOD))?.errorCode).toBe('SUBMISSION_FAILED');
    advance(30);
    expect((await runChargeCycle(deps)).charged).toBe(2);
  });

  it('one failing subscription does not stop the others', async () => {
    const { chain, deps } = await setup(3);
    chain.chargeFailureQueue.set(2, [paymentFailed()]);
    const report = await runChargeCycle(deps);
    expect(report).toMatchObject({ charged: 2, retryScheduled: 1 });
  });

  it('notices that another keeper charged first and records no failure', async () => {
    const { chain, store, events, deps } = await setup();
    await chain.charge(1n); // another keeper wins the race; our store is still stale
    const report = await runChargeCycle(deps);
    expect(report).toMatchObject({ superseded: 1, charged: 0, failed: 0, retryScheduled: 0 });
    expect((await store.getCharge(1, START + PERIOD))?.status).toBe('superseded');
    expect(events).toEqual([]);
    // The store now has the new schedule, so the next cycle has nothing to do.
    expect((await store.getSub(1))?.nextChargeTs).toBe(START + 2 * PERIOD);
    expect((await runChargeCycle(deps)).due).toBe(0);
  });

  it('retries without penalty when the chain clock is behind (NotDue, schedule unchanged)', async () => {
    const { chain, store, events, deps, clock } = await setup();
    chain.now = START + PERIOD - 20; // the chain has not reached the due time yet
    const first = await runChargeCycle(deps);
    expect(first).toMatchObject({ retryScheduled: 1, failed: 0, superseded: 0 });
    const record = await store.getCharge(1, START + PERIOD);
    expect(record).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: clock.t + 15 });

    clock.t += 15;
    chain.now = START + PERIOD; // the chain caught up
    expect((await runChargeCycle(deps)).charged).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['charge.succeeded']);
  });

  it('marks a period superseded when the subscription was cancelled meanwhile', async () => {
    const { chain, store, events, deps } = await setup();
    chain.cancelSub(1);
    const report = await runChargeCycle(deps);
    expect(report).toMatchObject({ superseded: 1, charged: 0, failed: 0 });
    expect((await store.getSub(1))?.status).toBe('Cancelled');
    // The cancellation is noticed while refreshing, so merchants hear about it exactly once.
    expect(events.map((e) => e.type)).toEqual(['subscription.cancelled']);
  });

  it('skips a due subscription whose plan is not stored yet', async () => {
    const { chain, store, deps } = await setup();
    await store.upsertSub({
      id: 7,
      planId: 99,
      subscriber: 'GX',
      nextChargeTs: START,
      status: 'Active',
      charges: 0,
    });
    const report = await runChargeCycle(deps);
    expect(report).toMatchObject({ due: 2, charged: 1, skipped: 1 });
    expect(chain.chargeCalls).toEqual([1n]);
  });

  it('keeps charging when the event sink throws, and logs it', async () => {
    const { chain, deps } = await setup();
    const logged: string[] = [];
    const logger: Logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (message) => {
        logged.push(message);
      },
    };
    const report = await runChargeCycle({
      ...deps,
      logger,
      sink: { emit: () => Promise.reject(new Error('webhook store down')) },
    });
    expect(report.charged).toBe(1);
    expect(chain.chargeCalls).toHaveLength(1);
    expect(logged).toEqual(['event sink failed']);
  });

  it('stops the cycle with ReadOnlyError when the keeper cannot sign', async () => {
    const { chain, store, deps } = await setup();
    chain.chargeFailure = new ReadOnlyError('charge subscription 1');
    await expect(runChargeCycle(deps)).rejects.toBeInstanceOf(ReadOnlyError);
    // Nothing was recorded as a failed attempt.
    expect((await store.getCharge(1, START + PERIOD))?.attempts).toBe(0);
  });
});
