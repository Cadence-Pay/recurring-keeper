import type { ChainClient } from './chain.js';
import { nullSink, type EventSink, type KeeperEvent } from './events.js';
import {
  ContractCallError,
  KeeperError,
  ReadOnlyError,
  SimulationError,
  describe,
} from './errors.js';
import { toSubRecord } from './mappers.js';
import { silentLogger, type Logger } from './logger.js';
import type { ChargeRecord, PlanRecord, Store, SubRecord } from './store/types.js';

/** How the keeper retries and when it gives up. All times are in seconds. */
export interface ChargePolicy {
  /** Failed submissions in one round before the round is marked failed. */
  readonly maxAttempts: number;
  /** Wait after the first failure. It doubles with each further failure. */
  readonly backoffBaseSecs: number;
  /** Upper limit of the wait between attempts. */
  readonly backoffMaxSecs: number;
  /** After a round has failed, wait this long before opening a new round for the same period. */
  readonly failedCooldownSecs: number;
  /** Wait before trying again when the chain says the charge is not due yet (clock skew). */
  readonly notDueRetrySecs: number;
  /** Most due subscriptions handled in one cycle. */
  readonly batchSize: number;
}

/** Defaults: 5 attempts with waits of 30, 60, 120 and 240 s, then a 6 hour cooldown. */
export const DEFAULT_POLICY: ChargePolicy = {
  maxAttempts: 5,
  backoffBaseSecs: 30,
  backoffMaxSecs: 600,
  failedCooldownSecs: 6 * 60 * 60,
  notDueRetrySecs: 15,
  batchSize: 50,
};

/** Everything a charge cycle needs. */
export interface ChargeDeps {
  readonly chain: ChainClient;
  readonly store: Store;
  readonly sink?: EventSink;
  readonly logger?: Logger;
  /** Clock in seconds. Defaults to the system clock. */
  readonly now?: () => number;
  readonly policy?: ChargePolicy;
}

/** What one charge cycle did. */
export interface ChargeCycleReport {
  /** Subscriptions the store believed were due. */
  readonly due: number;
  /** Charges this keeper submitted successfully. */
  readonly charged: number;
  /** Periods that someone else charged, or whose subscription was cancelled, before we did. */
  readonly superseded: number;
  /** Attempts that failed and will be retried later. */
  readonly retryScheduled: number;
  /** Rounds that ran out of attempts and were marked failed. */
  readonly failed: number;
  /** Due subscriptions left alone (waiting for a retry time, or already handled). */
  readonly skipped: number;
}

type FailureKind = 'not-due' | 'not-active' | 'other';

interface Failure {
  readonly kind: FailureKind;
  /** Contract error name when there is one, otherwise the keeper error code. */
  readonly code: string;
  readonly message: string;
}

function classify(error: unknown): Failure {
  const contractError =
    error instanceof SimulationError || error instanceof ContractCallError
      ? error.contractError
      : undefined;
  const code = contractError ?? (error instanceof KeeperError ? error.code : 'UNKNOWN');
  const kind: FailureKind =
    contractError === 'NotDue' ? 'not-due' : contractError === 'NotActive' ? 'not-active' : 'other';
  return { kind, code, message: describe(error) };
}

/**
 * Charge every subscription that is due, one at a time.
 *
 * Submissions are sequential on purpose: they all use the keeper's account, and sending several at
 * once would make them fight over the account's sequence number (`txBadSeq`).
 *
 * For each due subscription there is one charge record per due time. A failed attempt is retried
 * with a growing wait. After `maxAttempts` failures the round is marked `failed` and one
 * `charge.failed` event is emitted. After `failedCooldownSecs` a new round starts, so a subscriber
 * who fixes their allowance is charged again. If the chain answers `NotDue` or `NotActive`, the
 * subscription is read again: if its schedule moved, another party charged it first (superseded,
 * no failure); if not, the keeper's clock is ahead and it tries again shortly.
 *
 * @param deps - Chain, store, event sink and policy.
 * @returns Counts of what happened.
 * @throws ReadOnlyError if the keeper has no signing key. Other errors are handled per subscription.
 */
export async function runChargeCycle(deps: ChargeDeps): Promise<ChargeCycleReport> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const logger = deps.logger ?? silentLogger;
  const sink = deps.sink ?? nullSink;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const { chain, store } = deps;

  const counts = { charged: 0, superseded: 0, retryScheduled: 0, failed: 0, skipped: 0 };
  const dueSubs = await store.listDueSubs(now(), policy.batchSize);

  const emit = async (event: KeeperEvent): Promise<void> => {
    try {
      await sink.emit(event);
    } catch (error) {
      logger.error('event sink failed', { type: event.type, error: describe(error) });
    }
  };

  const refresh = async (subId: number): Promise<SubRecord | undefined> => {
    try {
      const record = toSubRecord(BigInt(subId), await chain.getSubscription(BigInt(subId)));
      await store.upsertSub(record);
      return record;
    } catch (error) {
      logger.warn('could not refresh subscription', { subId, error: describe(error) });
      return undefined;
    }
  };

  const baseEvent = (sub: SubRecord, plan: PlanRecord) => ({
    merchant: plan.merchant,
    planId: plan.id,
    subId: sub.id,
    subscriber: sub.subscriber,
    occurredAt: now(),
  });

  for (const sub of dueSubs) {
    const plan = await store.getPlan(sub.planId);
    if (plan === undefined) {
      logger.warn('due subscription has no stored plan yet', { subId: sub.id, planId: sub.planId });
      counts.skipped++;
      continue;
    }

    let record: ChargeRecord | undefined = await store.getCharge(sub.id, sub.nextChargeTs);
    if (record === undefined) {
      record = await store.insertCharge({
        subId: sub.id,
        planId: plan.id,
        dueTs: sub.nextChargeTs,
        amount: plan.amount,
        status: 'pending',
        attempts: 0,
        txHash: null,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
      });
    } else if (record.status === 'succeeded' || record.status === 'superseded') {
      counts.skipped++; // handled; the next sync brings the new schedule
      continue;
    } else if (record.nextAttemptAt !== null && record.nextAttemptAt > now()) {
      counts.skipped++; // waiting for the retry time or the cooldown
      continue;
    } else if (record.status === 'failed') {
      record = { ...record, status: 'pending', attempts: 0, nextAttemptAt: null };
    }

    try {
      const outcome = await chain.charge(BigInt(sub.id));
      await store.saveCharge({
        ...record,
        status: 'succeeded',
        txHash: outcome.txHash,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
      });
      counts.charged++;
      logger.info('charged', { subId: sub.id, txHash: outcome.txHash });
      await emit({
        type: 'charge.succeeded',
        ...baseEvent(sub, plan),
        token: plan.token,
        amount: plan.amount,
        txHash: outcome.txHash,
      });
      await refresh(sub.id);
    } catch (error) {
      if (error instanceof ReadOnlyError) throw error;
      const failure = classify(error);

      if (failure.kind === 'not-active') {
        await refresh(sub.id);
        await store.saveCharge({ ...record, status: 'superseded', nextAttemptAt: null });
        counts.superseded++;
        continue;
      }

      if (failure.kind === 'not-due') {
        const fresh = await refresh(sub.id);
        if (fresh !== undefined && fresh.nextChargeTs !== sub.nextChargeTs) {
          // The schedule moved: someone else charged this period first.
          await store.saveCharge({ ...record, status: 'superseded', nextAttemptAt: null });
          counts.superseded++;
        } else {
          // Nothing changed, so the chain clock is behind ours. Try again shortly, no penalty.
          await store.saveCharge({
            ...record,
            status: 'pending',
            nextAttemptAt: now() + policy.notDueRetrySecs,
          });
          counts.retryScheduled++;
        }
        continue;
      }

      const attempts = record.attempts + 1;
      if (attempts >= policy.maxAttempts) {
        await store.saveCharge({
          ...record,
          status: 'failed',
          attempts,
          errorCode: failure.code,
          errorMessage: failure.message,
          nextAttemptAt: now() + policy.failedCooldownSecs,
        });
        counts.failed++;
        logger.warn('charge failed, giving up for now', {
          subId: sub.id,
          attempts,
          errorCode: failure.code,
        });
        // WAVE-ISSUE(keeper-1): dunning (for example an email to the subscriber) plugs in here.
        // The MVP only emits the charge.failed event, which merchants receive as a webhook.
        await emit({
          type: 'charge.failed',
          ...baseEvent(sub, plan),
          token: plan.token,
          amount: plan.amount,
          attempts,
          errorCode: failure.code,
          errorMessage: failure.message,
        });
      } else {
        const wait = Math.min(policy.backoffBaseSecs * 2 ** (attempts - 1), policy.backoffMaxSecs);
        await store.saveCharge({
          ...record,
          status: 'pending',
          attempts,
          errorCode: failure.code,
          errorMessage: failure.message,
          nextAttemptAt: now() + wait,
        });
        counts.retryScheduled++;
        logger.warn('charge failed, will retry', {
          subId: sub.id,
          attempts,
          retryInSecs: wait,
          errorCode: failure.code,
        });
      }
    }
  }

  return { due: dueSubs.length, ...counts };
}
