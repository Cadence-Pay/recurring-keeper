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

/** Which counter of the sync cursor to read or write. */
export type CursorName = 'plans' | 'subs';

/**
 * Storage used by the keeper. All methods return promises so that a database server can be
 * plugged in later. The SQLite implementation is the only one today.
 */
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
  /** Release the underlying resources. */
  close(): void;
}
