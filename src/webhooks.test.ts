import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeeperEvent } from './events.js';
import type { Logger } from './logger.js';
import { SqliteStore } from './store/sqlite.js';
import {
  DEFAULT_WEBHOOK_POLICY,
  WebhookSink,
  buildPayload,
  deliverDue,
  signBody,
  type WebhookEndpoints,
} from './webhooks.js';

const MERCHANT = 'GAIPBT4WCBUALPT77TFYIK4LAHN67QNFM4OOTX3VEH4L6URNOUFJOTSQ';
const SECRET = 'super-secret-signing-key-0123456789';
const URL_ = 'https://hooks.example.com/recurring?token=do-not-log-this';
const ENDPOINTS: WebhookEndpoints = { [MERCHANT]: { url: URL_, secret: SECRET } };

const EVENT: KeeperEvent = {
  type: 'charge.succeeded',
  merchant: MERCHANT,
  planId: 1,
  subId: 2,
  subscriber: 'GACJH7JXHQWIW66GHZFNMCK2I7WOZ562QAOF7B7PUENTAPRGC5RLW24A',
  occurredAt: 1000,
  token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  amount: '10000000',
  txHash: 'abc',
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
}

/** A fake fetch that answers from a queue (a status number, or an Error to throw). */
function fakeFetch(answers: (number | Error)[]) {
  const sent: Sent[] = [];
  const impl = ((url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body as string,
      redirect: init.redirect,
    });
    const answer = answers.shift() ?? 200;
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(new Response(null, { status: answer }));
  }) as typeof fetch;
  return { impl, sent };
}

async function queued(store: SqliteStore, id = 'd1', now = 1000) {
  await new WebhookSink(store, ENDPOINTS, { now: () => now, newId: () => id }).emit(EVENT);
}

describe('signBody', () => {
  it('matches the published HMAC-SHA256 test vector', () => {
    expect(signBody('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('changes when the body or the secret changes', () => {
    expect(signBody('a', 'x')).not.toBe(signBody('a', 'y'));
    expect(signBody('a', 'x')).not.toBe(signBody('b', 'x'));
  });
});

describe('buildPayload', () => {
  it('wraps the event with an id, type, time and data', () => {
    const body = JSON.parse(buildPayload('id-1', EVENT, 1234)) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'id-1',
      type: 'charge.succeeded',
      createdAt: 1234,
      data: { merchant: MERCHANT, subId: 2, amount: '10000000', txHash: 'abc' },
    });
    expect(body['data']).not.toHaveProperty('type');
  });
});

describe('WebhookSink', () => {
  it('queues a delivery for a merchant with an endpoint', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store);
    const record = await store.getDelivery('d1');
    expect(record).toMatchObject({
      merchant: MERCHANT,
      eventType: 'charge.succeeded',
      status: 'pending',
      attempts: 0,
    });
    expect(JSON.parse(record?.payload ?? '{}')).toMatchObject({ id: 'd1', createdAt: 1000 });
  });

  it('drops events for a merchant without an endpoint', async () => {
    const store = new SqliteStore(':memory:');
    await new WebhookSink(store, {}, { newId: () => 'd1' }).emit(EVENT);
    expect(await store.getDelivery('d1')).toBeUndefined();
  });
});

describe('deliverDue', () => {
  it('posts the stored body with a correct signature and the delivery id', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store);
    const { impl, sent } = fakeFetch([200]);
    const report = await deliverDue({ store, endpoints: ENDPOINTS, fetch: impl, now: () => 1000 });
    expect(report).toEqual({ delivered: 1, retryScheduled: 0, failed: 0 });

    const request = sent[0];
    expect(request?.url).toBe(URL_);
    // Recompute the signature independently of the code under test.
    const expected = `sha256=${createHmac('sha256', SECRET)
      .update(request?.body ?? '')
      .digest('hex')}`;
    expect(request?.headers['x-recurring-signature']).toBe(expected);
    expect(request?.headers['x-recurring-delivery']).toBe('d1');
    expect(request?.headers['x-recurring-event']).toBe('charge.succeeded');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.redirect).toBe('manual');
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({ id: 'd1' });
    expect(await store.getDelivery('d1')).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  it('retries a 500 later with the same id and body', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store);
    const { impl, sent } = fakeFetch([500, 200]);
    const clock = { t: 1000 };
    const deps = { store, endpoints: ENDPOINTS, fetch: impl, now: () => clock.t };

    expect(await deliverDue(deps)).toMatchObject({ retryScheduled: 1, delivered: 0 });
    expect(await store.getDelivery('d1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 1030,
      lastError: 'receiver answered HTTP 500',
    });

    // Not due yet, so nothing is sent.
    clock.t = 1029;
    await deliverDue(deps);
    expect(sent).toHaveLength(1);

    clock.t = 1030;
    expect(await deliverDue(deps)).toMatchObject({ delivered: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(sent[1]?.headers['x-recurring-delivery']).toBe('d1');
    expect(await store.getDelivery('d1')).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('retries network errors and timeouts', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store, 'a');
    await queued(store, 'b');
    const { impl } = fakeFetch([
      new Error('fetch failed'),
      new DOMException('timeout', 'TimeoutError'),
    ]);
    const report = await deliverDue({ store, endpoints: ENDPOINTS, fetch: impl, now: () => 1000 });
    expect(report.retryScheduled).toBe(2);
    expect((await store.getDelivery('a'))?.lastError).toContain('fetch failed');
  });

  it('retries 429 and 408, but not other 4xx or redirects', async () => {
    const store = new SqliteStore(':memory:');
    // Deliveries are processed in id order, so the ids are numbered to match the answers.
    for (const id of ['1-429', '2-408', '3-400', '4-404', '5-302']) await queued(store, id);
    const { impl } = fakeFetch([429, 408, 400, 404, 302]);
    const report = await deliverDue({ store, endpoints: ENDPOINTS, fetch: impl, now: () => 1000 });
    expect(report).toEqual({ delivered: 0, retryScheduled: 2, failed: 3 });
    expect((await store.getDelivery('3-400'))?.status).toBe('failed');
    expect((await store.getDelivery('5-302'))?.status).toBe('failed');
    expect((await store.getDelivery('1-429'))?.status).toBe('pending');
  });

  it('gives up for good after the maximum number of attempts', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store);
    const { impl, sent } = fakeFetch([503, 503, 503, 503]);
    const clock = { t: 1000 };
    const deps = {
      store,
      endpoints: ENDPOINTS,
      fetch: impl,
      now: () => clock.t,
      policy: { ...DEFAULT_WEBHOOK_POLICY, maxAttempts: 3 },
    };
    await deliverDue(deps); // attempt 1, retry in 30 s
    clock.t += 30;
    await deliverDue(deps); // attempt 2, retry in 60 s
    clock.t += 60;
    expect(await deliverDue(deps)).toMatchObject({ failed: 1 }); // attempt 3
    expect(await store.getDelivery('d1')).toMatchObject({
      status: 'failed',
      attempts: 3,
      nextAttemptAt: null,
    });
    // A failed delivery is never picked up again.
    clock.t += 100_000;
    await deliverDue(deps);
    expect(sent).toHaveLength(3);
  });

  it('caps the wait between attempts', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store);
    const { impl } = fakeFetch([500, 500, 500]);
    const clock = { t: 1000 };
    const deps = {
      store,
      endpoints: ENDPOINTS,
      fetch: impl,
      now: () => clock.t,
      policy: { ...DEFAULT_WEBHOOK_POLICY, backoffMaxSecs: 40 },
    };
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await deliverDue(deps);
      const next = (await store.getDelivery('d1'))?.nextAttemptAt ?? 0;
      waits.push(next - clock.t);
      clock.t = next;
    }
    expect(waits).toEqual([30, 40, 40]);
  });

  it('fails a delivery whose merchant has no endpoint any more', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store);
    const { impl, sent } = fakeFetch([]);
    const report = await deliverDue({ store, endpoints: {}, fetch: impl, now: () => 1000 });
    expect(report.failed).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await store.getDelivery('d1'))?.lastError).toContain('no webhook endpoint');
  });

  it('handles at most batchSize deliveries per pass', async () => {
    const store = new SqliteStore(':memory:');
    for (const id of ['a', 'b', 'c']) await queued(store, id);
    const { impl, sent } = fakeFetch([]);
    const deps = {
      store,
      endpoints: ENDPOINTS,
      fetch: impl,
      now: () => 1000,
      policy: { ...DEFAULT_WEBHOOK_POLICY, batchSize: 2 },
    };
    await deliverDue(deps);
    expect(sent).toHaveLength(2);
    await deliverDue(deps);
    expect(sent).toHaveLength(3);
  });

  it('never writes the secret, signature, body or full URL to the logs', async () => {
    const store = new SqliteStore(':memory:');
    await queued(store, 'a-ok');
    await queued(store, 'b-bad');
    await queued(store, 'c-down');
    const lines: string[] = [];
    const record = (message: string, fields?: Record<string, unknown>) => {
      lines.push(JSON.stringify({ message, ...fields }));
    };
    const logger: Logger = { info: record, warn: record, error: record };
    const { impl, sent } = fakeFetch([200, 400, new Error(`connect failed ${URL_}`)]);
    await deliverDue({ store, endpoints: ENDPOINTS, fetch: impl, logger, now: () => 1000 });

    expect(lines.length).toBeGreaterThanOrEqual(3);
    const everything = lines.join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('sha256=');
    expect(everything).not.toContain('do-not-log-this'); // the token inside the URL
    expect((await store.getDelivery('c-down'))?.lastError).not.toContain('do-not-log-this');
    expect((await store.getDelivery('c-down'))?.lastError).toContain('<webhook url>');
    for (const request of sent) {
      expect(everything).not.toContain(request.headers['x-recurring-signature'] ?? 'unreachable');
      expect(everything).not.toContain('"subscriber"');
    }
  });
});
