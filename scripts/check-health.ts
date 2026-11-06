/*
 * Health check for a running keeper, meant for a scheduler or monitor. Exit code 0 means healthy.
 * Exit code 1 means a problem, and each problem is printed. Exit code 2 means bad usage.
 *
 *   node scripts/check-health.ts --url http://127.0.0.1:8080 [--max-age-secs 90] [--expect charging|readonly|any]
 *
 * It checks that the keeper answers, that it has finished a sync recently, and that it is in the
 * mode you expect (a keeper that should charge but is read only is a problem).
 */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const healthSchema = z.object({
  status: z.literal('ok'),
  network: z.string(),
  contractId: z.string(),
  readOnly: z.boolean(),
  lastSyncAt: z.number().int().nullable(),
});

export interface HealthOptions {
  /** Longest time since the last finished sync, in seconds. */
  readonly maxAgeSecs: number;
  readonly expect: 'charging' | 'readonly' | 'any';
}

/**
 * Judge a `/health` answer.
 *
 * @param body - The parsed JSON the keeper returned.
 * @param options - What counts as healthy.
 * @param nowSecs - The current time in seconds.
 * @returns The problems found. An empty list means healthy.
 */
export function evaluateHealth(body: unknown, options: HealthOptions, nowSecs: number): string[] {
  const parsed = healthSchema.safeParse(body);
  if (!parsed.success) return ['the keeper answered, but not in the documented shape'];
  const health = parsed.data;
  const problems: string[] = [];
  if (health.lastSyncAt === null) {
    problems.push('the keeper has not finished a sync yet');
  } else if (nowSecs - health.lastSyncAt > options.maxAgeSecs) {
    problems.push(
      `the last sync finished ${String(nowSecs - health.lastSyncAt)} s ago, more than the allowed ${String(options.maxAgeSecs)} s`,
    );
  }
  if (options.expect === 'charging' && health.readOnly) {
    problems.push('the keeper is read only, but it is expected to charge');
  }
  if (options.expect === 'readonly' && !health.readOnly) {
    problems.push('the keeper can submit charges, but it is expected to be read only');
  }
  return problems;
}

/** Where the checker gets its inputs. Replaceable in tests. */
export interface Deps {
  readonly fetch: typeof fetch;
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

/** Run the check. Returns the exit code. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  let url: string;
  let options: HealthOptions;
  try {
    const args = parseArgs(argv);
    if (args['url'] === undefined) throw new Error('--url is required');
    url = new URL('/health', args['url']).href;
    const expect = args['expect'] ?? 'charging';
    if (expect !== 'charging' && expect !== 'readonly' && expect !== 'any') {
      throw new Error('--expect must be charging, readonly or any');
    }
    const maxAgeSecs = Number(args['max-age-secs'] ?? '90');
    if (!Number.isFinite(maxAgeSecs) || maxAgeSecs < 1) {
      throw new Error('--max-age-secs must be a positive number');
    }
    options = { maxAgeSecs, expect };
  } catch (error) {
    deps.out(`usage error: ${error instanceof Error ? error.message : 'bad arguments'}`);
    return 2;
  }
  let body: unknown;
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      deps.out(`UNHEALTHY: the keeper answered HTTP ${String(response.status)}`);
      return 1;
    }
    body = await response.json();
  } catch {
    deps.out('UNHEALTHY: the keeper did not answer');
    return 1;
  }
  const problems = evaluateHealth(body, options, deps.now());
  if (problems.length === 0) {
    deps.out('healthy');
    return 0;
  }
  for (const problem of problems) deps.out(`UNHEALTHY: ${problem}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), {
    fetch,
    now: () => Math.floor(Date.now() / 1000),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
}
