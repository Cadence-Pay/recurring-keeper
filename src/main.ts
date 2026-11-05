import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApi } from './api.js';
import { createChainClient, type ChainClient } from './chain.js';
import { describeConfig, loadConfig, type Config } from './config.js';
import { ConfigError, describe } from './errors.js';
import { consoleLogger, type Logger } from './logger.js';
import { runKeeperLoop } from './loop.js';
import { SqliteStore } from './store/sqlite.js';
import type { Store } from './store/types.js';
import { WebhookSink, deliverDue } from './webhooks.js';

/** Pieces that tests replace. Everything else is built from the configuration. */
export interface KeeperOverrides {
  readonly chain?: ChainClient;
  readonly store?: Store;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A configured keeper that has not started yet. */
export interface Keeper {
  /** The HTTP API. `run` starts it listening. */
  readonly app: FastifyInstance;
  readonly store: Store;
  /**
   * Start the API and the keeper loop. Resolves after `signal` is aborted, the loop has stopped
   * and the API and database are closed.
   */
  run(signal: AbortSignal): Promise<void>;
}

/**
 * Assemble the keeper from validated configuration: chain client, database, webhook queue, the
 * run loop and the read API.
 *
 * @param config - Validated configuration.
 * @param overrides - Replacements for tests.
 */
export function createKeeper(config: Config, overrides: KeeperOverrides = {}): Keeper {
  const logger = overrides.logger ?? consoleLogger;
  const now = overrides.now ?? (() => Math.floor(Date.now() / 1000));
  const store = overrides.store ?? new SqliteStore(config.dbPath);
  const chain = overrides.chain ?? createChainClient(config);
  const sink = new WebhookSink(store, config.webhooks, { now, logger });
  const status = { lastSyncAt: null as number | null };

  const app = buildApi({
    store,
    corsOrigins: config.api.corsOrigins,
    health: () => ({
      network: config.network,
      contractId: config.contractId,
      readOnly: config.readOnly,
      lastSyncAt: status.lastSyncAt,
    }),
  });

  return {
    app,
    store,
    async run(signal) {
      await app.listen({ host: config.api.host, port: config.api.port });
      logger.info('keeper started', { ...describeConfig(config) });
      try {
        await runKeeperLoop({
          chain,
          store,
          sink,
          logger,
          now,
          intervalMs: config.pollIntervalSecs * 1000,
          signal,
          ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
          onSynced: () => {
            status.lastSyncAt = now();
          },
          afterPass: () =>
            deliverDue({
              store,
              endpoints: config.webhooks,
              logger,
              now,
              ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
            }),
        });
      } finally {
        await app.close();
        store.close();
        logger.info('keeper stopped');
      }
    },
  };
}

/**
 * Entry point: read the environment, start the keeper and stop cleanly on SIGINT or SIGTERM.
 *
 * @param env - Environment variables, usually `process.env`.
 * @returns The process exit code.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const keeper = createKeeper(config);
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await keeper.run(controller.signal);
    return 0;
  } catch (error) {
    consoleLogger.error('keeper crashed', { error: describe(error) });
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
