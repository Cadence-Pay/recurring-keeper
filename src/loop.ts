import { runChargeCycle, type ChargeDeps } from './charger.js';
import { describe } from './errors.js';
import { silentLogger } from './logger.js';
import { syncOnce } from './sync.js';

/** Wait `ms` milliseconds, or less if the signal is aborted. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** Settings for the run loop. */
export interface LoopOptions extends ChargeDeps {
  /** Pause between passes, in milliseconds. */
  readonly intervalMs: number;
  /** Abort to stop the loop after the current pass. */
  readonly signal: AbortSignal;
  /** Replaceable in tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called at the end of each pass, for example to deliver queued webhooks. */
  readonly afterPass?: () => Promise<unknown>;
}

/**
 * Run the keeper: sync from the chain, charge what is due, wait, repeat until aborted.
 *
 * An error in one pass is logged and the next pass still runs, so a bad RPC moment does not stop
 * the keeper. A read-only keeper keeps syncing but logs that it cannot charge.
 *
 * @param options - Dependencies, interval and stop signal.
 * @returns When the signal is aborted.
 */
export async function runKeeperLoop(options: LoopOptions): Promise<void> {
  const logger = options.logger ?? silentLogger;
  const sleep = options.sleep ?? abortableSleep;
  while (!options.signal.aborted) {
    try {
      const sync = await syncOnce(options.chain, options.store, {
        ...(options.sink === undefined ? {} : { sink: options.sink }),
        ...(options.now === undefined ? {} : { now: options.now }),
        logger,
      });
      logger.info('synced', {
        newPlans: sync.newPlans,
        newSubs: sync.newSubs,
        refreshedSubs: sync.refreshedSubs,
        problems: sync.problems.length,
      });
      for (const problem of sync.problems) logger.warn('sync problem', { ...problem });
      // WAVE-ISSUE(keeper-2): coordination with the soroban-keeper-network plugs in here, for
      // example taking work from or handing it to other keepers. The MVP runs its own simple loop.
      const cycle = await runChargeCycle(options);
      if (cycle.due > 0) logger.info('charge cycle', { ...cycle });
    } catch (error) {
      logger.error('keeper pass failed', { error: describe(error) });
    }
    try {
      await options.afterPass?.();
    } catch (error) {
      logger.error('after-pass task failed', { error: describe(error) });
    }
    await sleep(options.intervalMs, options.signal);
  }
}
