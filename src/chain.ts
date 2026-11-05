import { Keypair } from '@stellar/stellar-sdk';
import {
  AssembledTransaction,
  KeypairSigner,
  SentTransaction,
} from '@stellar/stellar-sdk/contract';
import type { Config } from './config.js';
import { Client, type Plan, type Subscription } from './contract/index.js';
import {
  ContractCallError,
  KeeperError,
  ReadOnlyError,
  RpcError,
  RpcTimeoutError,
  SimulationError,
  SubmissionError,
  contractErrorName,
  parseContractCode,
} from './errors.js';

/** Result of a successful charge. */
export interface ChargeOutcome {
  /** Hash of the transaction that carried the charge. */
  readonly txHash: string;
}

/**
 * Everything the keeper needs from the chain. The sync, charge and API code depend on this
 * interface only, so tests can replace it with a fake.
 */
export interface ChainClient {
  /** Number of plans created. Plan ids run from 1 to this value. */
  getPlanCount(): Promise<bigint>;
  /** Number of subscriptions created. Subscription ids run from 1 to this value. */
  getSubCount(): Promise<bigint>;
  /** Read one plan. Throws ContractCallError(PlanNotFound) for an unknown id. */
  getPlan(planId: bigint): Promise<Plan>;
  /** Read one subscription. Throws ContractCallError(SubNotFound) for an unknown id. */
  getSubscription(subId: bigint): Promise<Subscription>;
  /**
   * Submit a charge for a subscription and wait until it is included.
   * Throws SimulationError when the contract refuses (for example NotDue), ReadOnlyError when no
   * key is configured, RpcTimeoutError on timeout and SubmissionError when sending fails.
   */
  charge(subId: bigint): Promise<ChargeOutcome>;
}

/** The part of a simulated call that the keeper uses. */
export interface SimulatedCall<T> {
  readonly result: T;
  /**
   * Raw simulation response. When the contract refuses a call, `error` holds the network text,
   * for example `HostError: Error(Contract, #3)`. The SDK's own error value is built from doc
   * comments and can be empty, so the code is read from here.
   */
  readonly simulation?: unknown;
  signAndSend(): Promise<SentCall<T>>;
}

/** The part of a submitted call that the keeper uses. */
export interface SentCall<T> {
  readonly result: T;
  readonly sendTransactionResponse?: { readonly hash: string } | undefined;
}

/** A contract `Result`: either a value or a contract error carrying its name. */
export interface ContractResult<T> {
  isErr(): boolean;
  unwrap(): T;
  unwrapErr(): { message: string };
}

/**
 * The calls of the generated contract client that the keeper uses. The generated `Client`
 * satisfies this shape; tests pass a fake that does too.
 */
export interface ContractApi {
  plan_count(): Promise<SimulatedCall<bigint>>;
  sub_count(): Promise<SimulatedCall<bigint>>;
  get_plan(args: { plan_id: bigint }): Promise<SimulatedCall<ContractResult<Plan>>>;
  get_subscription(args: { sub_id: bigint }): Promise<SimulatedCall<ContractResult<Subscription>>>;
  charge(
    args: { sub_id: bigint },
    options?: { timeoutInSeconds?: number },
  ): Promise<SimulatedCall<ContractResult<null>>>;
}

/** Limits and mode for an RpcChainClient. */
export interface RpcChainClientOptions {
  /** Time allowed for one read or simulation. */
  readonly rpcTimeoutMs: number;
  /** Time allowed to submit a transaction and wait for it to be included. */
  readonly txTimeoutMs: number;
  /** When true, `charge` throws ReadOnlyError without touching the network. */
  readonly readOnly: boolean;
}

/** The `error` text of a raw simulation response, if it has one. */
function simulationErrorText(simulation: unknown): string | undefined {
  if (typeof simulation !== 'object' || simulation === null || !('error' in simulation)) {
    return undefined;
  }
  return typeof simulation.error === 'string' ? simulation.error : undefined;
}

/** Run a promise with a deadline. */
async function withTimeout<T>(work: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RpcTimeoutError(operation, ms));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Turn anything thrown by the SDK into one of our typed errors. */
function translate(error: unknown, operation: string): KeeperError {
  if (error instanceof KeeperError) return error;
  if (error instanceof AssembledTransaction.Errors.SimulationFailed) {
    return new SimulationError(operation, error);
  }
  if (error instanceof SentTransaction.Errors.TransactionStillPending) {
    return new RpcTimeoutError(operation, 0);
  }
  if (error instanceof SentTransaction.Errors.SendFailed) {
    return new SubmissionError(operation, error);
  }
  return new RpcError(operation, error);
}

/** ChainClient backed by a contract client talking to a Stellar RPC server. */
export class RpcChainClient implements ChainClient {
  private readonly api: ContractApi;
  private readonly options: RpcChainClientOptions;

  /**
   * @param api - The generated contract client, or a fake with the same shape.
   * @param options - Time limits and read-only mode.
   */
  constructor(api: ContractApi, options: RpcChainClientOptions) {
    this.api = api;
    this.options = options;
  }

  async getPlanCount(): Promise<bigint> {
    return this.read('read plan count', () => this.api.plan_count());
  }

  async getSubCount(): Promise<bigint> {
    return this.read('read subscription count', () => this.api.sub_count());
  }

  async getPlan(planId: bigint): Promise<Plan> {
    const operation = `read plan ${String(planId)}`;
    const call = await this.readCall(operation, () => this.api.get_plan({ plan_id: planId }));
    return this.unwrap(call.result, call, operation);
  }

  async getSubscription(subId: bigint): Promise<Subscription> {
    const operation = `read subscription ${String(subId)}`;
    const call = await this.readCall(operation, () => this.api.get_subscription({ sub_id: subId }));
    return this.unwrap(call.result, call, operation);
  }

  async charge(subId: bigint): Promise<ChargeOutcome> {
    const operation = `charge subscription ${String(subId)}`;
    if (this.options.readOnly) throw new ReadOnlyError(operation);
    try {
      const simulated = await withTimeout(
        this.api.charge(
          { sub_id: subId },
          { timeoutInSeconds: Math.ceil(this.options.txTimeoutMs / 1000) },
        ),
        this.options.rpcTimeoutMs,
        `simulate ${operation}`,
      );
      this.unwrap(simulated.result, simulated, operation);
      const sent = await withTimeout(
        simulated.signAndSend(),
        this.options.txTimeoutMs,
        `submit ${operation}`,
      );
      this.unwrap(sent.result, simulated, operation);
      const txHash = sent.sendTransactionResponse?.hash;
      if (txHash === undefined) {
        throw new SubmissionError(operation, new Error('the network returned no transaction hash'));
      }
      return { txHash };
    } catch (error) {
      throw translate(error, operation);
    }
  }

  private async read<T>(operation: string, run: () => Promise<SimulatedCall<T>>): Promise<T> {
    return (await this.readCall(operation, run)).result;
  }

  private async readCall<T>(
    operation: string,
    run: () => Promise<SimulatedCall<T>>,
  ): Promise<SimulatedCall<T>> {
    try {
      return await withTimeout(run(), this.options.rpcTimeoutMs, operation);
    } catch (error) {
      throw translate(error, operation);
    }
  }

  /**
   * Unwrap a contract result. On a contract error the name comes from the raw simulation text if
   * it has a code, because the SDK's own message can be empty. Otherwise the SDK message is used.
   */
  private unwrap<T>(
    result: ContractResult<T>,
    call: { readonly simulation?: unknown },
    operation: string,
  ): T {
    if (!result.isErr()) return result.unwrap();
    const raw = simulationErrorText(call.simulation);
    const code = raw === undefined ? undefined : parseContractCode(raw);
    const name =
      (code === undefined ? undefined : contractErrorName(code)) ?? result.unwrapErr().message;
    throw new ContractCallError(operation, name === '' ? 'unknown contract error' : name);
  }
}

/**
 * Build a ChainClient for a real network from validated configuration.
 *
 * @param config - Validated configuration. The signing key is used only if `readOnly` is false.
 * @returns A client that reads over RPC and, if a key is configured, can submit charges.
 */
export function createChainClient(config: Config): ChainClient {
  const keypair =
    config.readOnly || config.keeperSecretKey === undefined
      ? undefined
      : Keypair.fromSecret(config.keeperSecretKey);
  const client = new Client({
    contractId: config.contractId,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
    allowHttp: config.rpcUrl.startsWith('http://'),
    ...(keypair === undefined
      ? {}
      : {
          publicKey: keypair.publicKey(),
          signTransaction: new KeypairSigner(keypair, config.networkPassphrase),
        }),
  });
  return new RpcChainClient(client, {
    rpcTimeoutMs: config.rpcTimeoutMs,
    txTimeoutMs: config.txTimeoutMs,
    readOnly: keypair === undefined,
  });
}
