import { AssembledTransaction, SentTransaction } from '@stellar/stellar-sdk/contract';
import { describe, expect, it, vi } from 'vitest';
import {
  RpcChainClient,
  createChainClient,
  type ContractApi,
  type ContractResult,
  type SentCall,
  type SimulatedCall,
} from './chain.js';
import { loadConfig } from './config.js';
import type { Plan, Subscription } from './contract/index.js';
import {
  ContractCallError,
  ReadOnlyError,
  RpcError,
  RpcTimeoutError,
  SimulationError,
  SubmissionError,
} from './errors.js';

const PLAN: Plan = {
  merchant: 'GAIPBT4WCBUALPT77TFYIK4LAHN67QNFM4OOTX3VEH4L6URNOUFJOTSQ',
  token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  amount: 10_000_000n,
  period_secs: 60n,
  active: true,
};

const SUB: Subscription = {
  plan_id: 1n,
  subscriber: 'GACJH7JXHQWIW66GHZFNMCK2I7WOZ562QAOF7B7PUENTAPRGC5RLW24A',
  next_charge_ts: 1_793_882_880n,
  status: { tag: 'Active', values: undefined },
  charges: 0,
};

function ok<T>(value: T): ContractResult<T> {
  return {
    isErr: () => false,
    unwrap: () => value,
    unwrapErr: () => {
      throw new Error('not an error');
    },
  };
}

function err<T>(message: string): ContractResult<T> {
  return {
    isErr: () => true,
    unwrap: () => {
      throw new Error(message);
    },
    unwrapErr: () => ({ message }),
  };
}

function simulated<T>(
  result: T,
  send?: () => Promise<SentCall<T>>,
  simulationError?: string,
): SimulatedCall<T> {
  return {
    result,
    simulation: simulationError === undefined ? undefined : { error: simulationError },
    signAndSend:
      send ?? (() => Promise.resolve({ result, sendTransactionResponse: { hash: 'abc123' } })),
  };
}

function fakeApi(overrides: Partial<ContractApi> = {}): ContractApi {
  return {
    plan_count: () => Promise.resolve(simulated(3n)),
    sub_count: () => Promise.resolve(simulated(5n)),
    get_plan: () => Promise.resolve(simulated(ok(PLAN))),
    get_subscription: () => Promise.resolve(simulated(ok(SUB))),
    charge: () => Promise.resolve(simulated(ok(null))),
    ...overrides,
  };
}

const LIVE = { rpcTimeoutMs: 1000, txTimeoutMs: 1000, readOnly: false };

describe('RpcChainClient reads', () => {
  it('returns counts, plans and subscriptions', async () => {
    const client = new RpcChainClient(fakeApi(), LIVE);
    expect(await client.getPlanCount()).toBe(3n);
    expect(await client.getSubCount()).toBe(5n);
    expect(await client.getPlan(1n)).toEqual(PLAN);
    expect(await client.getSubscription(1n)).toEqual(SUB);
  });

  it('turns a contract Err into ContractCallError with the code', async () => {
    const client = new RpcChainClient(
      fakeApi({ get_plan: () => Promise.resolve(simulated(err<Plan>('PlanNotFound'))) }),
      LIVE,
    );
    const failure = await client.getPlan(9n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractCallError);
    expect((failure as ContractCallError).contractError).toBe('PlanNotFound');
    expect((failure as ContractCallError).contractCode).toBe(3);
  });

  it('reads the error name from the raw simulation text when the SDK message is empty', async () => {
    // The real SDK builds the message from doc comments, which can be empty.
    const client = new RpcChainClient(
      fakeApi({
        get_plan: () =>
          Promise.resolve(simulated(err<Plan>(''), undefined, 'HostError: Error(Contract, #3)')),
        get_subscription: () => Promise.resolve(simulated(err<Subscription>(''))),
      }),
      LIVE,
    );
    const failure = await client.getPlan(9n).catch((e: unknown) => e);
    expect((failure as ContractCallError).contractError).toBe('PlanNotFound');
    expect((failure as ContractCallError).contractCode).toBe(3);
    // With neither a code nor a message the error is still reported, not swallowed.
    const unknown = await client.getSubscription(9n).catch((e: unknown) => e);
    expect((unknown as ContractCallError).contractError).toBe('unknown contract error');
  });

  it('times out when the RPC never answers', async () => {
    const client = new RpcChainClient(fakeApi({ plan_count: () => new Promise(() => undefined) }), {
      ...LIVE,
      rpcTimeoutMs: 20,
    });
    const failure = await client.getPlanCount().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcTimeoutError);
    expect((failure as RpcTimeoutError).timeoutMs).toBe(20);
  });

  it('wraps an unexpected failure in RpcError', async () => {
    const client = new RpcChainClient(
      fakeApi({ sub_count: () => Promise.reject(new Error('socket hang up')) }),
      LIVE,
    );
    const failure = await client.getSubCount().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as RpcError).message).toContain('socket hang up');
  });

  it('maps a failed simulation to SimulationError', async () => {
    const client = new RpcChainClient(
      fakeApi({
        get_subscription: () =>
          Promise.reject(
            new AssembledTransaction.Errors.SimulationFailed('HostError: Error(Contract, #5)'),
          ),
      }),
      LIVE,
    );
    const failure = await client.getSubscription(1n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SimulationError);
    expect((failure as SimulationError).contractError).toBe('SubNotFound');
  });
});

describe('RpcChainClient.charge', () => {
  it('submits and returns the transaction hash', async () => {
    const charge = vi.fn(() => Promise.resolve(simulated(ok(null))));
    const client = new RpcChainClient(fakeApi({ charge }), LIVE);
    expect(await client.charge(7n)).toEqual({ txHash: 'abc123' });
    expect(charge).toHaveBeenCalledWith({ sub_id: 7n }, { timeoutInSeconds: 1 });
  });

  it('does not touch the network when read only', async () => {
    const charge = vi.fn(() => Promise.resolve(simulated(ok(null))));
    const client = new RpcChainClient(fakeApi({ charge }), { ...LIVE, readOnly: true });
    await expect(client.charge(1n)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(charge).not.toHaveBeenCalled();
  });

  it('reports a simulation failure with the contract error (NotDue)', async () => {
    const client = new RpcChainClient(
      fakeApi({
        charge: () =>
          Promise.reject(
            new AssembledTransaction.Errors.SimulationFailed('HostError: Error(Contract, #7)'),
          ),
      }),
      LIVE,
    );
    const failure = await client.charge(1n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SimulationError);
    expect((failure as SimulationError).contractCode).toBe(7);
    expect((failure as SimulationError).contractError).toBe('NotDue');
  });

  it('reports PaymentFailed from the simulation', async () => {
    const client = new RpcChainClient(
      fakeApi({
        charge: () =>
          Promise.reject(
            new AssembledTransaction.Errors.SimulationFailed('HostError: Error(Contract, #10)'),
          ),
      }),
      LIVE,
    );
    const failure = await client.charge(1n).catch((e: unknown) => e);
    expect((failure as SimulationError).contractError).toBe('PaymentFailed');
  });

  it('reports a contract Err returned in the simulated result', async () => {
    const client = new RpcChainClient(
      fakeApi({ charge: () => Promise.resolve(simulated(err<null>('NotActive'))) }),
      LIVE,
    );
    const failure = await client.charge(1n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractCallError);
    expect((failure as ContractCallError).contractError).toBe('NotActive');
  });

  it('times out while simulating', async () => {
    const client = new RpcChainClient(fakeApi({ charge: () => new Promise(() => undefined) }), {
      ...LIVE,
      rpcTimeoutMs: 20,
    });
    await expect(client.charge(1n)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('times out while waiting for inclusion', async () => {
    const hang = (): Promise<SentCall<ContractResult<null>>> => new Promise(() => undefined);
    const client = new RpcChainClient(
      fakeApi({ charge: () => Promise.resolve(simulated(ok(null), hang)) }),
      { ...LIVE, txTimeoutMs: 20 },
    );
    await expect(client.charge(1n)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('maps a transaction that stays pending to a timeout', async () => {
    const pending = (): Promise<SentCall<ContractResult<null>>> =>
      Promise.reject(new SentTransaction.Errors.TransactionStillPending('still pending'));
    const client = new RpcChainClient(
      fakeApi({ charge: () => Promise.resolve(simulated(ok(null), pending)) }),
      LIVE,
    );
    await expect(client.charge(1n)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('maps a rejected submission to SubmissionError', async () => {
    const failing = (): Promise<SentCall<ContractResult<null>>> =>
      Promise.reject(new SentTransaction.Errors.SendFailed('txBadSeq'));
    const client = new RpcChainClient(
      fakeApi({ charge: () => Promise.resolve(simulated(ok(null), failing)) }),
      LIVE,
    );
    const failure = await client.charge(1n).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SubmissionError);
    expect((failure as SubmissionError).message).toContain('txBadSeq');
  });

  it('fails when the network returns no transaction hash', async () => {
    const noHash = (): Promise<SentCall<ContractResult<null>>> =>
      Promise.resolve({ result: ok(null) });
    const client = new RpcChainClient(
      fakeApi({ charge: () => Promise.resolve(simulated(ok(null), noHash)) }),
      LIVE,
    );
    await expect(client.charge(1n)).rejects.toBeInstanceOf(SubmissionError);
  });
});

describe('createChainClient', () => {
  const env = {
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    CONTRACT_ID: 'CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E',
  };

  it('builds a read-only client from configuration without any network call', async () => {
    const client = createChainClient(loadConfig(env));
    await expect(client.charge(1n)).rejects.toBeInstanceOf(ReadOnlyError);
  });
});
