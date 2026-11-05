import { z } from 'zod';
import { ConfigError } from './errors.js';

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
});

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
  };
}
