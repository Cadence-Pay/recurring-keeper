import type { ChainClient } from './chain.js';
import { describe } from './errors.js';
import { toPlanRecord, toSubRecord } from './mappers.js';
import type { Store } from './store/types.js';

/** One id that could not be synced. */
export interface SyncProblem {
  readonly kind: 'plan' | 'subscription';
  readonly id: number;
  readonly message: string;
}

/** What one sync pass did. */
export interface SyncReport {
  /** Plans copied for the first time. */
  readonly newPlans: number;
  /** Subscriptions copied for the first time. */
  readonly newSubs: number;
  /** Already known active plans that were read again. */
  readonly refreshedPlans: number;
  /** Already known active subscriptions that were read again. */
  readonly refreshedSubs: number;
  /** Ids that failed. They are retried on the next pass. */
  readonly problems: readonly SyncProblem[];
}

/** Optional limits for a sync pass. */
export interface SyncOptions {
  /** How many chain reads may run at the same time while refreshing. Default 5. */
  readonly concurrency?: number;
}

/** Run `work` over `items` with at most `limit` running at once. */
async function inBatches<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(work));
  }
}

/**
 * Copy new plans and subscriptions from the chain into the store and refresh the active ones.
 *
 * It reads `plan_count` and `sub_count`, copies every id above the stored cursor in order, and
 * advances the cursor after each id, so a pass that stops halfway resumes where it stopped. Then
 * it reads again every plan and subscription that was active, to pick up deactivations, charges
 * and cancellations. An id that fails is reported in `problems` and does not stop the others.
 * New ids are always tried before refreshes. The cursor never skips an id that failed.
 *
 * @param chain - Where to read from.
 * @param store - Where to write to.
 * @param options - Optional limits.
 * @returns A report of what changed.
 * @throws KeeperError if the counts cannot be read at all.
 */
export async function syncOnce(
  chain: ChainClient,
  store: Store,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const problems: SyncProblem[] = [];
  let newPlans = 0;
  let newSubs = 0;

  const planCount = Number(await chain.getPlanCount());
  const subCount = Number(await chain.getSubCount());

  // Snapshot what to refresh before adding new ids, so new ids are not read twice.
  const refreshPlanIds = await store.listActivePlanIds();
  const refreshSubIds = await store.listActiveSubIds();

  for (let id = (await store.getCursor('plans')) + 1; id <= planCount; id++) {
    try {
      await store.upsertPlan(toPlanRecord(BigInt(id), await chain.getPlan(BigInt(id))));
      await store.setCursor('plans', id);
      newPlans++;
    } catch (error) {
      problems.push({ kind: 'plan', id, message: describe(error) });
      break; // keep ids in order: the cursor must not skip this one
    }
  }

  for (let id = (await store.getCursor('subs')) + 1; id <= subCount; id++) {
    try {
      await store.upsertSub(toSubRecord(BigInt(id), await chain.getSubscription(BigInt(id))));
      await store.setCursor('subs', id);
      newSubs++;
    } catch (error) {
      problems.push({ kind: 'subscription', id, message: describe(error) });
      break;
    }
  }

  let refreshedPlans = 0;
  await inBatches(refreshPlanIds, concurrency, async (id) => {
    try {
      await store.upsertPlan(toPlanRecord(BigInt(id), await chain.getPlan(BigInt(id))));
      refreshedPlans++;
    } catch (error) {
      problems.push({ kind: 'plan', id, message: describe(error) });
    }
  });

  let refreshedSubs = 0;
  await inBatches(refreshSubIds, concurrency, async (id) => {
    try {
      await store.upsertSub(toSubRecord(BigInt(id), await chain.getSubscription(BigInt(id))));
      refreshedSubs++;
    } catch (error) {
      problems.push({ kind: 'subscription', id, message: describe(error) });
    }
  });

  return { newPlans, newSubs, refreshedPlans, refreshedSubs, problems };
}
