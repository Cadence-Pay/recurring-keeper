import { describe, expect, it } from 'vitest';
import { createChainClient } from './chain.js';
import { loadConfig } from './config.js';
import { ContractCallError } from './errors.js';

/**
 * Read-only checks against the real testnet deployment from docs/TESTNET.md (in the monorepo).
 * They need the network and the testnet contract, which is wiped when testnet resets, so they only
 * run when LIVE_TESTNET=1. They never sign or submit anything.
 */
describe.skipIf(process.env['LIVE_TESTNET'] !== '1')('live testnet reads', () => {
  const client = createChainClient(
    loadConfig({
      STELLAR_NETWORK: 'testnet',
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      CONTRACT_ID: 'CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E',
    }),
  );

  it('reads the plan and subscription left by the smoke test', async () => {
    expect(await client.getPlanCount()).toBeGreaterThanOrEqual(1n);
    const plan = await client.getPlan(1n);
    expect(plan.period_secs).toBe(60n);
    const sub = await client.getSubscription(1n);
    expect(sub.plan_id).toBe(1n);
  }, 60_000);

  it('reports an unknown plan as PlanNotFound with its code', async () => {
    const failure = await client.getPlan(999_999n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractCallError);
    expect((failure as ContractCallError).contractError).toBe('PlanNotFound');
    expect((failure as ContractCallError).contractCode).toBe(3);
  }, 60_000);
});
