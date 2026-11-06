/**
 * Typed errors for the keeper. Every error has a stable `code` string so callers and logs can
 * branch on it without parsing messages.
 */

import { Error as ContractErrorTable } from './contract/index.js';

/** Base class of every error this package throws on purpose. */
export class KeeperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The environment configuration is missing or invalid. */
export class ConfigError extends KeeperError {
  constructor(message: string) {
    super('CONFIG', message);
  }
}

/** An RPC request did not finish within the allowed time. */
export class RpcTimeoutError extends KeeperError {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super('RPC_TIMEOUT', `${operation} did not finish within ${String(timeoutMs)} ms`);
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** An RPC request failed for a reason other than a timeout or a simulation failure. */
export class RpcError extends KeeperError {
  constructor(operation: string, cause: unknown) {
    super('RPC', `${operation} failed: ${describe(cause)}`, { cause });
  }
}

/**
 * The network rejected the call while simulating it. If the contract itself refused, the contract
 * error code and name are set (for example 7 and `NotDue`).
 */
export class SimulationError extends KeeperError {
  readonly contractCode: number | undefined;
  readonly contractError: string | undefined;

  constructor(operation: string, cause: unknown) {
    const message = describe(cause);
    super('SIMULATION_FAILED', `${operation} failed in simulation: ${message}`, { cause });
    this.contractCode = parseContractCode(message);
    this.contractError =
      this.contractCode === undefined ? undefined : contractErrorName(this.contractCode);
  }
}

/** The transaction was built and signed but could not be submitted or did not succeed. */
export class SubmissionError extends KeeperError {
  constructor(operation: string, cause: unknown) {
    super('SUBMISSION_FAILED', `${operation} could not be submitted: ${describe(cause)}`, {
      cause,
    });
  }
}

/** The contract returned one of its own errors. */
export class ContractCallError extends KeeperError {
  readonly contractCode: number | undefined;
  readonly contractError: string;

  constructor(operation: string, contractError: string) {
    super('CONTRACT_ERROR', `${operation} was refused by the contract: ${contractError}`);
    this.contractError = contractError;
    this.contractCode = contractErrorCode(contractError);
  }
}

/** The fee of a transaction is above the configured limit, or could not be determined. */
export class FeeCapError extends KeeperError {
  constructor(operation: string, detail: string) {
    super('FEE_CAP_EXCEEDED', `${operation} was not submitted: ${detail}`);
  }
}

/** A signing operation was requested but no keeper key is configured. */
export class ReadOnlyError extends KeeperError {
  constructor(operation: string) {
    super('READ_ONLY', `${operation} needs a keeper signing key, but the keeper is read only`);
  }
}

/** Longest error text that is logged or stored. The RPC can answer with pages of diagnostics. */
const MAX_ERROR_TEXT = 400;

/** Short text for an unknown thrown value, cut to a sensible length. */
export function describe(value: unknown): string {
  const text =
    value instanceof Error ? value.message : typeof value === 'string' ? value : 'unknown error';
  return text.length <= MAX_ERROR_TEXT ? text : `${text.slice(0, MAX_ERROR_TEXT)}… (cut)`;
}

/** Pull the numeric contract error code out of a Soroban error message, if there is one. */
export function parseContractCode(message: string): number | undefined {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/** Name of a contract error code from the generated bindings, or undefined if unknown. */
export function contractErrorName(code: number): string | undefined {
  const entry = (ContractErrorTable as Record<number, { message: string } | undefined>)[code];
  return entry?.message;
}

/** Code of a contract error name from the generated bindings, or undefined if unknown. */
export function contractErrorCode(name: string): number | undefined {
  for (const [code, entry] of Object.entries(ContractErrorTable)) {
    if (entry.message === name) return Number(code);
  }
  return undefined;
}
