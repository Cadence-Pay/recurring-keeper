import { createHmac, randomUUID } from 'node:crypto';
import type { EventSink, KeeperEvent } from './events.js';
import { describe } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import type { DeliveryRecord, Store } from './store/types.js';

/** Where and how to deliver webhooks for one merchant. */
export interface WebhookEndpoint {
  readonly url: string;
  /** Shared secret used to sign the body. Never log it. */
  readonly secret: string;
}

/** Endpoints by merchant address. */
export type WebhookEndpoints = Readonly<Record<string, WebhookEndpoint>>;

/** Retry and timeout settings. Times are in seconds except `timeoutMs`. */
export interface WebhookPolicy {
  /** Failed attempts before a delivery is marked failed for good. */
  readonly maxAttempts: number;
  readonly backoffBaseSecs: number;
  readonly backoffMaxSecs: number;
  /** Time allowed for one HTTP request. */
  readonly timeoutMs: number;
  /** Most deliveries handled in one pass. */
  readonly batchSize: number;
}

/** Defaults: 8 attempts with waits of 30 s doubling up to 1 hour, 10 s request timeout. */
export const DEFAULT_WEBHOOK_POLICY: WebhookPolicy = {
  maxAttempts: 8,
  backoffBaseSecs: 30,
  backoffMaxSecs: 3600,
  timeoutMs: 10_000,
  batchSize: 50,
};

/**
 * Sign a request body.
 *
 * @param secret - The merchant's shared secret.
 * @param body - The exact bytes sent, as text.
 * @returns `sha256=` followed by the lowercase hex HMAC-SHA256 of the body.
 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/**
 * Build the JSON text of a webhook.
 *
 * Merchants should treat `id` as an idempotency key: a retry sends the same `id` and the same body.
 *
 * @param deliveryId - Unique id of this delivery.
 * @param event - The event to report.
 * @param createdAt - Creation time in seconds.
 */
export function buildPayload(deliveryId: string, event: KeeperEvent, createdAt: number): string {
  const { type, ...data } = event;
  return JSON.stringify({ id: deliveryId, type, createdAt, data });
}

/** Turns events into stored deliveries for the merchants that have an endpoint. */
export class WebhookSink implements EventSink {
  private readonly store: Store;
  private readonly endpoints: WebhookEndpoints;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly logger: Logger;

  /**
   * @param store - Where deliveries are queued.
   * @param endpoints - Merchant endpoints. Events for other merchants are dropped.
   * @param options - Clock, id source and logger, replaceable in tests.
   */
  constructor(
    store: Store,
    endpoints: WebhookEndpoints,
    options: { now?: () => number; newId?: () => string; logger?: Logger } = {},
  ) {
    this.store = store;
    this.endpoints = endpoints;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? silentLogger;
  }

  async emit(event: KeeperEvent): Promise<void> {
    if (this.endpoints[event.merchant] === undefined) {
      this.logger.info('no webhook endpoint for merchant, event not queued', {
        type: event.type,
        merchant: event.merchant,
      });
      return;
    }
    const id = this.newId();
    await this.store.insertDelivery({
      id,
      merchant: event.merchant,
      eventType: event.type,
      payload: buildPayload(id, event, this.now()),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  }
}

/** What one delivery pass did. */
export interface DeliveryReport {
  readonly delivered: number;
  /** Failed attempts that will be retried. */
  readonly retryScheduled: number;
  /** Deliveries that will not be retried. */
  readonly failed: number;
}

/** Everything a delivery pass needs. */
export interface DeliverDeps {
  readonly store: Store;
  readonly endpoints: WebhookEndpoints;
  /** HTTP client. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly policy?: WebhookPolicy;
}

/** Statuses worth retrying: the receiver may recover. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Send every webhook that is due.
 *
 * Each request is a POST of the stored JSON with `X-Recurring-Signature` (HMAC-SHA256 of the body),
 * `X-Recurring-Delivery` (the idempotency id) and `X-Recurring-Event`. A 2xx answer marks the
 * delivery delivered. Network errors, timeouts, 408, 429 and 5xx answers are retried with a growing
 * wait up to `maxAttempts`. Any other answer (including redirects, which are not followed) fails
 * the delivery at once, and so does a merchant with no endpoint any more.
 *
 * Logs name the delivery id, merchant, host and status only. They never contain the secret, the
 * signature, the body or the full URL.
 *
 * @param deps - Store, endpoints, HTTP client and policy.
 * @returns Counts of what happened.
 */
export async function deliverDue(deps: DeliverDeps): Promise<DeliveryReport> {
  const policy = deps.policy ?? DEFAULT_WEBHOOK_POLICY;
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const send = deps.fetch ?? fetch;
  const due = await deps.store.listDueDeliveries(now(), policy.batchSize);
  const counts = { delivered: 0, retryScheduled: 0, failed: 0 };

  const fail = async (record: DeliveryRecord, reason: string, retryable: boolean) => {
    const attempts = record.attempts + 1;
    if (!retryable || attempts >= policy.maxAttempts) {
      await deps.store.saveDelivery({
        ...record,
        status: 'failed',
        attempts,
        nextAttemptAt: null,
        lastError: reason,
      });
      counts.failed++;
      logger.warn('webhook delivery failed for good', { deliveryId: record.id, attempts, reason });
      return;
    }
    const wait = Math.min(policy.backoffBaseSecs * 2 ** (attempts - 1), policy.backoffMaxSecs);
    await deps.store.saveDelivery({
      ...record,
      attempts,
      nextAttemptAt: now() + wait,
      lastError: reason,
    });
    counts.retryScheduled++;
    logger.warn('webhook delivery failed, will retry', {
      deliveryId: record.id,
      attempts,
      retryInSecs: wait,
      reason,
    });
  };

  for (const record of due) {
    const endpoint = deps.endpoints[record.merchant];
    if (endpoint === undefined) {
      await fail(record, 'no webhook endpoint configured for this merchant', false);
      continue;
    }
    const host = new URL(endpoint.url).host;
    try {
      const response = await send(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-recurring-signature': signBody(endpoint.secret, record.payload),
          'x-recurring-delivery': record.id,
          'x-recurring-event': record.eventType,
        },
        body: record.payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      if (response.status >= 200 && response.status < 300) {
        await deps.store.saveDelivery({
          ...record,
          status: 'delivered',
          attempts: record.attempts + 1,
          nextAttemptAt: null,
          lastError: null,
        });
        counts.delivered++;
        logger.info('webhook delivered', {
          deliveryId: record.id,
          merchant: record.merchant,
          host,
          status: response.status,
        });
      } else {
        await fail(
          record,
          `receiver answered HTTP ${String(response.status)}`,
          isRetryableStatus(response.status),
        );
      }
    } catch (error) {
      // Error text can echo the URL, and URLs often carry tokens, so scrub it before storing.
      await fail(
        record,
        `request failed: ${describe(error).replaceAll(endpoint.url, '<webhook url>')}`,
        true,
      );
    }
  }
  return counts;
}
