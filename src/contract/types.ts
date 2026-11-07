/**
 * GENERATED FILE. Do not edit by hand.
 *
 * Typed bindings for the recurring-contracts Soroban contract.
 * Generated 2026-11-05 with:
 *   stellar-js generate --contract-id CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E \
 *     --network testnet --output-dir ./src/contract --contract-name recurring-contracts
 * using @stellar/stellar-sdk 17.4.0, from the contract deployed on testnet with wasm hash
 * dde9e953b6c94497f390ae99318a77f6f3937dacd260434648747c8183e68e3c
 * (recurring-contracts source commit ade108a, see https://github.com/Cadence-Pay/recurring-contracts/blob/main/docs/TESTNET.md).
 * To regenerate after a contract change, rerun the command with the new contract id and
 * update this header. The package.json, tsconfig.json and README the generator also writes
 * were removed because the files live inside the keeper package.
 */
import {Address} from '@stellar/stellar-sdk';

    /**
 * Error Enum: Error
 */
export const Error = {
  /**
   * Amount is zero or negative.
   */
  1 : { message: "InvalidAmount" },
  /**
   * Period is outside MIN_PERIOD_SECS..=MAX_PERIOD_SECS.
   */
  2 : { message: "InvalidPeriod" },
  3 : { message: "PlanNotFound" },
  /**
   * The plan was deactivated and accepts no new subscriptions.
   */
  4 : { message: "PlanInactive" },
  5 : { message: "SubNotFound" },
  /**
   * The subscription is cancelled.
   */
  6 : { message: "NotActive" },
  /**
   * The next charge time has not been reached.
   */
  7 : { message: "NotDue" },
  /**
   * The caller may not perform this action.
   */
  8 : { message: "NotAuthorized" },
  /**
   * An arithmetic operation overflowed.
   */
  9 : { message: "Overflow" },
  /**
   * The token transfer failed: balance too low, allowance too low or expired, or the token
   * refused. Without this, the token's own error code would pass through and could be read as
   * one of the codes above (for example the token's code 9 looks like `Overflow`).
   */
  10 : { message: "PaymentFailed" }
}

/**
 * A billing plan created by a merchant.
 */
export interface Plan {
  /**
   * False once deactivated. No new subscriptions, existing ones keep working.
   */
  active: boolean;
  /**
   * Amount per period, in the token's smallest unit.
   */
  amount: bigint;
  /**
   * Receives every payment and may deactivate the plan.
   */
  merchant: string;
  /**
   * Length of one billing period in seconds.
   */
  period_secs: bigint;
  /**
   * SEP-41 token contract used for payments.
   */
  token: string;
}

/**
 * Lifecycle state of a subscription.
 */
 export type SubStatus =
  { tag: "Active"; values: void } |
  { tag: "Cancelled"; values: void };

/**
 * A subscriber's subscription to a plan.
 */
export interface Subscription {
  /**
   * Number of successful charges after the first payment made at subscribe.
   */
  charges: number;
  /**
   * Ledger timestamp (seconds) from which the next charge is allowed.
   */
  next_charge_ts: bigint;
  plan_id: bigint;
  status: SubStatus;
  subscriber: string;
}

/**
 * Event: Charged
 */
export interface ChargedEvent {
  name: "Charged";
  data: {
    sub_id: bigint;
    plan_id: bigint;
    subscriber: string;
    amount?: bigint;
    /**
     * Total successful charges after the first payment, including this one.
     */
    charges?: number;
    next_charge_ts?: bigint;
  };
}

/**
 * Event: Cancelled
 */
export interface CancelledEvent {
  name: "Cancelled";
  data: {
    sub_id: bigint;
    plan_id: bigint;
    subscriber: string;
    /**
     * The subscriber or the plan merchant.
     */
    cancelled_by?: string;
  };
}

/**
 * Event: Subscribed
 */
export interface SubscribedEvent {
  name: "Subscribed";
  data: {
    sub_id: bigint;
    plan_id: bigint;
    subscriber: string;
    /**
     * Amount paid now for the first period.
     */
    amount?: bigint;
    next_charge_ts?: bigint;
  };
}

/**
 * Event: PlanCreated
 */
export interface PlanCreatedEvent {
  name: "PlanCreated";
  data: {
    plan_id: bigint;
    merchant: string;
    token?: string;
    amount?: bigint;
    period_secs?: bigint;
  };
}

/**
 * Event: PlanDeactivated
 */
export interface PlanDeactivatedEvent {
  name: "PlanDeactivated";
  data: {
    plan_id: bigint;
    merchant: string;
  };
}
    export type ContractEvent = ChargedEvent | CancelledEvent | SubscribedEvent | PlanCreatedEvent | PlanDeactivatedEvent;
    
