import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { KeeperError } from './errors.js';
import type { ChargeRecord, PlanRecord, Store, SubRecord } from './store/types.js';

/** A requested resource does not exist. */
export class NotFoundError extends KeeperError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
  }
}

/** Status shown by `GET /health`. */
export interface HealthInfo {
  readonly network: string;
  readonly contractId: string;
  /** True when the keeper cannot submit charges. */
  readonly readOnly: boolean;
  /** When the last full sync finished, in seconds, or null if none has yet. */
  readonly lastSyncAt: number | null;
}

/** What `buildApi` needs. */
export interface ApiOptions {
  readonly store: Store;
  /** Origins allowed to call the API from a browser. `*` allows any. Empty means no CORS headers. */
  readonly corsOrigins: readonly string[];
  readonly health: () => HealthInfo;
}

const address = z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a Stellar account address');
const id = z.coerce.number().int().min(1);
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const plansQuery = z.object({ merchant: address.optional(), ...page });
const pageQuery = z.object(page);
const idParams = z.object({ id });
const merchantParams = z.object({ address });

function planJson(plan: PlanRecord) {
  return {
    id: plan.id,
    merchant: plan.merchant,
    token: plan.token,
    amount: plan.amount,
    periodSecs: plan.periodSecs,
    active: plan.active,
  };
}

function subJson(sub: SubRecord) {
  return {
    id: sub.id,
    planId: sub.planId,
    subscriber: sub.subscriber,
    nextChargeTs: sub.nextChargeTs,
    status: sub.status,
    charges: sub.charges,
  };
}

function chargeJson(charge: ChargeRecord) {
  return {
    id: charge.id,
    subId: charge.subId,
    planId: charge.planId,
    dueTs: charge.dueTs,
    amount: charge.amount,
    status: charge.status,
    attempts: charge.attempts,
    txHash: charge.txHash,
    errorCode: charge.errorCode,
    nextAttemptAt: charge.nextAttemptAt,
    createdAt: charge.createdAt,
    updatedAt: charge.updatedAt,
  };
}

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/**
 * Build the read-only HTTP API. It does not start listening; call `listen` on the result, or use
 * `inject` in tests.
 *
 * Routes (all GET, JSON, public chain data only, no authentication):
 * `/health`, `/plans?merchant=&limit=&offset=`, `/plans/:id`, `/plans/:id/subscriptions`,
 * `/subscriptions/:id/charges` and `/merchants/:address/revenue`. Input is validated with zod;
 * bad input gives 400, unknown ids 404, anything else 500 with a generic message. Errors always
 * have the shape `{ "error": { "code", "message", "details"? } }`. See `openapi.yaml`.
 *
 * @param options - Store, CORS origins and health callback.
 * @returns A Fastify instance.
 */
export function buildApi(options: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store } = options;
  const allowAny = options.corsOrigins.includes('*');

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && (allowAny || options.corsOrigins.includes(origin))) {
      reply.header('access-control-allow-origin', allowAny ? '*' : origin);
      if (!allowAny) reply.header('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        reply.header('access-control-allow-methods', 'GET, OPTIONS');
        reply.header('access-control-allow-headers', 'content-type');
        reply.header('access-control-max-age', '600');
        return reply.code(204).send();
      }
    }
    return undefined;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      return reply.code(400).send(errorBody('INVALID_INPUT', 'The request is not valid', details));
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send(errorBody(error.code, error.message));
    }
    return reply.code(500).send(errorBody('INTERNAL', 'Internal error'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorBody('NOT_FOUND', 'No such route')),
  );

  // WAVE-ISSUE(keeper-4): a metrics endpoint (for example Prometheus) plugs in next to /health.
  app.get('/health', () => ({ status: 'ok', ...options.health() }));

  app.get('/plans', async (request) => {
    const query = plansQuery.parse(request.query);
    const result = await store.listPlans({
      ...(query.merchant === undefined ? {} : { merchant: query.merchant }),
      limit: query.limit,
      offset: query.offset,
    });
    return {
      items: result.items.map(planJson),
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/plans/:id', async (request) => {
    const { id: planId } = idParams.parse(request.params);
    const plan = await store.getPlan(planId);
    if (plan === undefined) throw new NotFoundError(`Plan ${String(planId)}`);
    return planJson(plan);
  });

  app.get('/plans/:id/subscriptions', async (request) => {
    const { id: planId } = idParams.parse(request.params);
    const query = pageQuery.parse(request.query);
    if ((await store.getPlan(planId)) === undefined)
      throw new NotFoundError(`Plan ${String(planId)}`);
    const result = await store.listSubsByPlan(planId, query.limit, query.offset);
    return {
      items: result.items.map(subJson),
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/subscriptions/:id/charges', async (request) => {
    const { id: subId } = idParams.parse(request.params);
    const query = pageQuery.parse(request.query);
    if ((await store.getSub(subId)) === undefined) {
      throw new NotFoundError(`Subscription ${String(subId)}`);
    }
    const result = await store.listCharges(subId, query.limit, query.offset);
    return {
      items: result.items.map(chargeJson),
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/merchants/:address/revenue', async (request) => {
    const params = merchantParams.parse(request.params);
    return {
      merchant: params.address,
      asOf: options.health().lastSyncAt,
      lines: await store.getRevenue(params.address),
    };
  });

  return app;
}
