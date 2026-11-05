import { z } from 'zod';
import { ConfigError } from './errors.js';
import type { WebhookEndpoints } from './webhooks.js';

/**
 * Well-known network passphrases. They are used only to catch a mismatch between the configured
 * network name and the configured passphrase. The value that is actually used always comes from
 * the environment.
 */
const KNOWN_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  STELLAR_NETWORK: z.string().min(1).max(32),
  STELLAR_RPC_URL: z.url({ protocol: /^https?$/ }),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/, 'must be a contract id starting with C'),
  KEEPER_SECRET_KEY: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, 'must be a Stellar secret key')
    .optional(),
  READ_ONLY: flag.default(false),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  TX_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300_000).default(60_000),
  WEBHOOK_CONFIG: z.string().optional(),
  MAX_FEE_STROOPS: z.coerce.bigint().positive().optional(),
  POLL_INTERVAL_SECS: z.coerce.number().int().min(1).max(3600).default(15),
  DB_PATH: z.string().min(1).default('./keeper.sqlite'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  CORS_ORIGINS: z.string().optional(),
});

/**
 * Shape of `WEBHOOK_CONFIG`: a JSON object from merchant address to its endpoint. The secret is
 * not in the JSON. `secretEnv` names the environment variable that holds it.
 */
const webhookConfig = z.record(
  z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a merchant address starting with G'),
  z.object({
    url: z.url({ protocol: /^https?$/ }),
    secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable name'),
  }),
);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Split `CORS_ORIGINS` into origins. Each must be `*` or an origin such as https://dash.example.com. */
function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  for (const origin of origins) {
    if (origin === '*') continue;
    let normalized: string | undefined;
    try {
      normalized = new URL(origin).origin;
    } catch {
      normalized = undefined;
    }
    if (normalized !== origin) {
      throw new ConfigError(
        'CORS_ORIGINS must list origins like https://dash.example.com (no path), or *',
      );
    }
  }
  return origins;
}

function parseWebhooks(raw: string | undefined, env: Record<string, string>): WebhookEndpoints {
  if (raw === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError('WEBHOOK_CONFIG is not valid JSON');
  }
  const parsed = webhookConfig.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || 'WEBHOOK_CONFIG'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid WEBHOOK_CONFIG. ${problems.join('; ')}`);
  }
  const endpoints: Record<string, { url: string; secret: string }> = {};
  for (const [merchant, entry] of Object.entries(parsed.data)) {
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
      throw new ConfigError(`Webhook URL for ${merchant} must use https`);
    }
    const secret = env[entry.secretEnv];
    if (secret === undefined || secret.length < 16) {
      throw new ConfigError(
        `Environment variable ${entry.secretEnv} (webhook secret for ${merchant}) must be set to at least 16 characters`,
      );
    }
    endpoints[merchant] = { url: entry.url, secret };
  }
  return endpoints;
}

/** Validated keeper configuration. */
export interface Config {
  /** Label of the network, for example `testnet` or `mainnet`. */
  readonly network: string;
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contractId: string;
  /** Secret key used to sign charges. Never log this. Absent when the keeper is read only. */
  readonly keeperSecretKey: string | undefined;
  /** True when no charge may be submitted: either asked for, or no key is configured. */
  readonly readOnly: boolean;
  /** Time allowed for one read or simulation request. */
  readonly rpcTimeoutMs: number;
  /** Time allowed to submit a transaction and wait for it to be included. */
  readonly txTimeoutMs: number;
  /** Webhook endpoints by merchant address, with their secrets. Never log this object. */
  readonly webhooks: WebhookEndpoints;
  /** Highest fee in stroops one charge may pay. Undefined means no limit. */
  readonly maxFeeStroops: bigint | undefined;
  /** Seconds between keeper passes. */
  readonly pollIntervalSecs: number;
  /** Path of the SQLite database file. */
  readonly dbPath: string;
  readonly api: {
    readonly host: string;
    readonly port: number;
    /** Browser origins allowed to call the API. `*` allows any. */
    readonly corsOrigins: readonly string[];
  };
}

/**
 * Read and validate the configuration from environment variables.
 *
 * Empty values count as unset, so a copied `.env.example` with blank values behaves like no value.
 * The error message names the invalid variables but never repeats their values.
 *
 * @param env - Usually `process.env`.
 * @returns The validated configuration.
 * @throws ConfigError if a variable is missing or invalid, or the passphrase does not match a known network name.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') present[key] = value;
  }
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration. ${problems.join('; ')}`);
  }
  const c = parsed.data;

  const expected = KNOWN_PASSPHRASES[c.STELLAR_NETWORK];
  if (expected !== undefined && expected !== c.STELLAR_NETWORK_PASSPHRASE) {
    throw new ConfigError(
      `STELLAR_NETWORK_PASSPHRASE does not match the passphrase of ${c.STELLAR_NETWORK}`,
    );
  }
  return {
    network: c.STELLAR_NETWORK,
    rpcUrl: c.STELLAR_RPC_URL,
    networkPassphrase: c.STELLAR_NETWORK_PASSPHRASE,
    contractId: c.CONTRACT_ID,
    keeperSecretKey: c.KEEPER_SECRET_KEY,
    readOnly: c.READ_ONLY || c.KEEPER_SECRET_KEY === undefined,
    rpcTimeoutMs: c.RPC_TIMEOUT_MS,
    txTimeoutMs: c.TX_TIMEOUT_MS,
    webhooks: parseWebhooks(c.WEBHOOK_CONFIG, present),
    maxFeeStroops: c.MAX_FEE_STROOPS,
    pollIntervalSecs: c.POLL_INTERVAL_SECS,
    dbPath: c.DB_PATH,
    api: { host: c.API_HOST, port: c.API_PORT, corsOrigins: parseCorsOrigins(c.CORS_ORIGINS) },
  };
}

/**
 * A copy of the configuration that is safe to log: the secret key is replaced by `set` or `unset`.
 *
 * @param config - A validated configuration.
 */
export function describeConfig(config: Config): Record<string, string | number | boolean> {
  return {
    network: config.network,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    contractId: config.contractId,
    keeperSecretKey: config.keeperSecretKey === undefined ? 'unset' : 'set',
    readOnly: config.readOnly,
    rpcTimeoutMs: config.rpcTimeoutMs,
    txTimeoutMs: config.txTimeoutMs,
    webhookMerchants: Object.keys(config.webhooks).length,
    maxFeeStroops: config.maxFeeStroops?.toString() ?? 'none',
    pollIntervalSecs: config.pollIntervalSecs,
    dbPath: config.dbPath,
    apiHost: config.api.host,
    apiPort: config.api.port,
    corsOrigins: config.api.corsOrigins.join(',') || 'none',
  };
}
