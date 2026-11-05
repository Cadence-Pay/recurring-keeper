import { nullSink, type EventSink, type KeeperEvent } from './events.js';
import { describe } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import type { Store, SubRecord } from './store/types.js';

/** What `recordSub` needs besides the store. */
export interface RecordContext {
  readonly store: Store;
  readonly sink?: EventSink;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * Save a subscription read from the chain and announce what changed.
 *
 * A new subscription produces `subscription.created`. A subscription that was `Active` in the
 * store and is `Cancelled` now produces `subscription.cancelled` (a subscription that is already
 * cancelled when first seen produces both). Events are skipped when `announce` is false, which the
 * very first sync uses so that history is not replayed to merchants. A failing sink is logged and
 * never stops the save.
 *
 * @param context - Store, sink, clock and logger.
 * @param record - The subscription as just read from the chain.
 * @param options - `isNew` is true for an id the store has not seen; `announce` turns events on.
 */
export async function recordSub(
  context: RecordContext,
  record: SubRecord,
  options: { isNew: boolean; announce: boolean },
): Promise<void> {
  const { store } = context;
  const previous = options.isNew ? undefined : await store.getSub(record.id);
  await store.upsertSub(record);
  if (!options.announce) return;

  const plan = await store.getPlan(record.planId);
  if (plan === undefined) return;
  const base = {
    merchant: plan.merchant,
    planId: plan.id,
    subId: record.id,
    subscriber: record.subscriber,
    occurredAt: (context.now ?? (() => Math.floor(Date.now() / 1000)))(),
  };
  const events: KeeperEvent[] = [];
  if (options.isNew) events.push({ type: 'subscription.created', ...base });
  if (record.status === 'Cancelled' && (options.isNew || previous?.status === 'Active')) {
    events.push({ type: 'subscription.cancelled', ...base });
  }
  const sink = context.sink ?? nullSink;
  for (const event of events) {
    try {
      await sink.emit(event);
    } catch (error) {
      (context.logger ?? silentLogger).error('event sink failed', {
        type: event.type,
        error: describe(error),
      });
    }
  }
}
