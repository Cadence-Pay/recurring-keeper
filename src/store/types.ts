/**
 * Records kept by the keeper and the storage interface.
 *
 * Ids and timestamps are plain numbers (they stay far below 2^53). Amounts are decimal strings
 * because the contract uses 128-bit integers.
 */

/** A plan as last read from the chain. */
export interface PlanRecord {
  readonly id: number;
  readonly merchant: string;
  readonly token: string;
  /** Amount per period in the token's smallest unit, as a decimal string. */
  readonly amount: string;
  readonly periodSecs: number;
  readonly active: boolean;
}

export type SubStatus = 'Active' | 'Cancelled';

/** A subscription as last read from the chain. */
export interface SubRecord {
  readonly id: number;
  readonly planId: number;
  readonly subscriber: string;
  /** Ledger timestamp in seconds from which the next charge is allowed. */
  readonly nextChargeTs: number;
  readonly status: SubStatus;
  /** Successful charges after the first payment. */
  readonly charges: number;
}

/**
 * State of the charge for one subscription period.
 * - `pending`: still to be attempted, or waiting for the next retry.
 * - `succeeded`: this keeper charged it.
 * - `failed`: gave up for now after the maximum number of attempts. Re-opened after a cooldown.
 * - `superseded`: another party charged it or the subscription was cancelled first.
 */
export type ChargeStatus = 'pending' | 'succeeded' | 'failed' | 'superseded';

/** One charge record per subscription and due time. */
export interface ChargeRecord {
  readonly id: number;
  readonly subId: number;
  readonly planId: number;
  /** The subscription's `next_charge_ts` this record is about. */
  readonly dueTs: number;
  /** Amount in the token's smallest unit, as a decimal string. */
  readonly amount: string;
  readonly status: ChargeStatus;
  /** Failed submissions counted so far in the current round. */
  readonly attempts: number;
  readonly txHash: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Earliest time to try again, or null when it can be tried now. */
  readonly nextAttemptAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A charge record that has not been stored yet. */
export type NewCharge = Omit<ChargeRecord, 'id' | 'createdAt' | 'updatedAt'>;

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/** One webhook to deliver to a merchant. The id is also sent to the merchant for idempotency. */
export interface DeliveryRecord {
  readonly id: string;
  readonly merchant: string;
  readonly eventType: string;
  /** The exact JSON text that is sent and signed. */
  readonly payload: string;
  readonly status: DeliveryStatus;
  /** Failed attempts so far. */
  readonly attempts: number;
  /** Earliest time to try again, or null when it can be tried now. */
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A delivery that has not been stored yet. */
export type NewDelivery = Omit<DeliveryRecord, 'createdAt' | 'updatedAt'>;

/**
 * Which counter of the sync cursor to read or write. `bootstrap` is 0 until the first sync pass
 * has finished and 1 afterwards.
 */
export type CursorName = 'plans' | 'subs' | 'bootstrap';

/** One page of a list, with the total number of matching items. */
export interface Page<T> {
  readonly items: T[];
  readonly total: number;
}

/**
 * Money received by a merchant in one token, counted from the subscriptions the keeper has
 * synced: every subscription paid its first period at subscribe plus one payment per charge.
 */
export interface RevenueLine {
  readonly token: string;
  /** Total in the token's smallest unit, as a decimal string. */
  readonly total: string;
  /** Number of payments the total is made of. */
  readonly payments: number;
}

/**
 * Storage used by the keeper. All methods return promises so that a database server can be
 * plugged in later. The SQLite implementation is the only one today.
 */
// WAVE-ISSUE(keeper-3): a Postgres adapter implements this interface. The MVP has SQLite only.
export interface Store {
  /** Highest id of this kind that has been copied from the chain. 0 means none yet. */
  getCursor(name: CursorName): Promise<number>;
  /** Remember that every id up to `value` has been copied. */
  setCursor(name: CursorName, value: number): Promise<void>;
  /** Insert a plan or replace the stored copy. */
  upsertPlan(plan: PlanRecord): Promise<void>;
  /** Insert a subscription or replace the stored copy. */
  upsertSub(sub: SubRecord): Promise<void>;
  getPlan(id: number): Promise<PlanRecord | undefined>;
  getSub(id: number): Promise<SubRecord | undefined>;
  /** Ids of plans that are still active, ascending. */
  listActivePlanIds(): Promise<number[]>;
  /** Ids of subscriptions that are still active, ascending. */
  listActiveSubIds(): Promise<number[]>;
  /** Active subscriptions whose next charge time is at or before `nowSecs`, oldest due first. */
  listDueSubs(nowSecs: number, limit: number): Promise<SubRecord[]>;
  /** Plans, newest id last, optionally only those of one merchant. */
  listPlans(options: {
    merchant?: string;
    limit: number;
    offset: number;
  }): Promise<Page<PlanRecord>>;
  /** Subscriptions to one plan, by id. */
  listSubsByPlan(planId: number, limit: number, offset: number): Promise<Page<SubRecord>>;
  /** Charge records of one subscription, by due time. */
  listCharges(subId: number, limit: number, offset: number): Promise<Page<ChargeRecord>>;
  /** What a merchant has received, per token, as of the last sync. */
  getRevenue(merchant: string): Promise<RevenueLine[]>;
  /** The charge record for a subscription period, if there is one. */
  getCharge(subId: number, dueTs: number): Promise<ChargeRecord | undefined>;
  /** Store a new charge record and return it with its id. */
  insertCharge(charge: NewCharge): Promise<ChargeRecord>;
  /** Replace the mutable fields of an existing charge record. */
  saveCharge(charge: ChargeRecord): Promise<void>;
  /** Store a new webhook delivery. */
  insertDelivery(delivery: NewDelivery): Promise<void>;
  getDelivery(id: string): Promise<DeliveryRecord | undefined>;
  /** Pending deliveries whose next attempt time has come, oldest first. */
  listDueDeliveries(nowSecs: number, limit: number): Promise<DeliveryRecord[]>;
  /** Replace the mutable fields of an existing delivery. */
  saveDelivery(delivery: DeliveryRecord): Promise<void>;
  /** Release the underlying resources. */
  close(): void;
}
