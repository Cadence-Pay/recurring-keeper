import type { Plan, Subscription } from './contract/index.js';
import { KeeperError } from './errors.js';
import type { PlanRecord, SubRecord } from './store/types.js';

/** A value from the chain does not fit the number range the keeper stores. */
export class DataRangeError extends KeeperError {
  constructor(what: string, value: bigint) {
    super('DATA_RANGE', `${what} is out of range: ${value.toString()}`);
  }
}

/** Convert a chain integer to a number, refusing values that would lose precision. */
export function toSafeInt(value: bigint, what: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DataRangeError(what, value);
  }
  return Number(value);
}

/**
 * Convert a plan read from the chain into a stored record.
 *
 * @param id - Plan id.
 * @param plan - Plan as returned by the contract bindings.
 * @throws DataRangeError if the id or period does not fit a safe integer.
 */
export function toPlanRecord(id: bigint, plan: Plan): PlanRecord {
  return {
    id: toSafeInt(id, 'plan id'),
    merchant: plan.merchant,
    token: plan.token,
    amount: plan.amount.toString(),
    periodSecs: toSafeInt(plan.period_secs, 'period'),
    active: plan.active,
  };
}

/**
 * Convert a subscription read from the chain into a stored record.
 *
 * @param id - Subscription id.
 * @param sub - Subscription as returned by the contract bindings.
 * @throws DataRangeError if an id or timestamp does not fit a safe integer.
 */
export function toSubRecord(id: bigint, sub: Subscription): SubRecord {
  return {
    id: toSafeInt(id, 'subscription id'),
    planId: toSafeInt(sub.plan_id, 'plan id'),
    subscriber: sub.subscriber,
    nextChargeTs: toSafeInt(sub.next_charge_ts, 'next charge time'),
    status: sub.status.tag,
    charges: sub.charges,
  };
}
