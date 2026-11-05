/**
 * Events the keeper reports to merchants. They carry no personal data: only addresses, ids,
 * amounts, timestamps and status.
 */

/** Fields shared by every event. */
interface EventBase {
  readonly merchant: string;
  readonly planId: number;
  readonly subId: number;
  readonly subscriber: string;
  /** When the keeper produced the event, in seconds. */
  readonly occurredAt: number;
}

export interface SubscriptionCreatedEvent extends EventBase {
  readonly type: 'subscription.created';
}

export interface ChargeSucceededEvent extends EventBase {
  readonly type: 'charge.succeeded';
  readonly token: string;
  readonly amount: string;
  readonly txHash: string;
}

export interface ChargeFailedEvent extends EventBase {
  readonly type: 'charge.failed';
  readonly token: string;
  readonly amount: string;
  /** Failed submissions in the round that just ended. */
  readonly attempts: number;
  /** Contract error name (for example `PaymentFailed`) or the keeper error code. */
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface SubscriptionCancelledEvent extends EventBase {
  readonly type: 'subscription.cancelled';
}

export type KeeperEvent =
  SubscriptionCreatedEvent | ChargeSucceededEvent | ChargeFailedEvent | SubscriptionCancelledEvent;

/** Where events go. Delivery to merchants is built on this in task 2.5. */
export interface EventSink {
  emit(event: KeeperEvent): Promise<void>;
}

/** A sink that drops every event. */
export const nullSink: EventSink = {
  emit: () => Promise.resolve(),
};
