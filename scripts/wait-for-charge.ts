/*
 * Wait until the keeper has charged a subscription a number of times. Exit code 0 when it has,
 * 1 on timeout, 2 on bad usage. Used by the release runbook to see that charging really happens.
 *
 *   node scripts/wait-for-charge.ts --url http://127.0.0.1:8080 --sub 2 [--count 1] [--timeout-secs 300]
 */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const chargesSchema = z.object({
  items: z.array(
    z.object({ status: z.string(), txHash: z.string().nullable(), dueTs: z.number() }),
  ),
  total: z.number(),
});

/** The transaction hashes of the charges that succeeded, in due order. */
export function succeededHashes(body: unknown): string[] {
  const parsed = chargesSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.items
    .filter((c) => c.status === 'succeeded')
    .map((c) => c.txHash)
    .filter((h): h is string => h !== null);
}

export interface Deps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly out: (line: string) => void;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error(`Bad arguments near "${key ?? ''}"`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

/** Run the wait. Returns the exit code. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  let url: string;
  let count: number;
  let timeoutMs: number;
  try {
    const args = parseArgs(argv);
    if (args['url'] === undefined || !/^[1-9]\d*$/.test(args['sub'] ?? '')) {
      throw new Error('--url and --sub (a positive number) are required');
    }
    url = new URL(`/subscriptions/${args['sub'] ?? ''}/charges`, args['url']).href;
    count = Number(args['count'] ?? '1');
    timeoutMs = Number(args['timeout-secs'] ?? '300') * 1000;
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
      throw new Error('--count must be a positive whole number and --timeout-secs at least 1');
    }
  } catch (error) {
    deps.out(`usage error: ${error instanceof Error ? error.message : 'bad arguments'}`);
    return 2;
  }
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    try {
      const response = await deps.fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const hashes = succeededHashes(await response.json());
        if (hashes.length >= count) {
          deps.out(`${String(hashes.length)} charge(s) succeeded`);
          for (const hash of hashes) deps.out(`CHARGE_TX=${hash}`);
          return 0;
        }
      }
    } catch {
      // The keeper may be busy or restarting. Keep waiting until the deadline.
    }
    if (deps.now() >= deadline) {
      deps.out(`TIMEOUT: fewer than ${String(count)} charge(s) succeeded in time`);
      return 1;
    }
    await deps.sleep(5000);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
}
