import { describe, expect, it } from 'vitest';
import {
  ContractCallError,
  KeeperError,
  SimulationError,
  contractErrorCode,
  contractErrorName,
  describe as describeValue,
  parseContractCode,
} from './errors.js';

describe('parseContractCode', () => {
  it('reads the code from a Soroban error message', () => {
    expect(parseContractCode('HostError: Error(Contract, #7)\n0: [Diagnostic Event]')).toBe(7);
    expect(parseContractCode('Error(Contract, #10)')).toBe(10);
  });

  it('returns undefined when there is no contract error', () => {
    expect(parseContractCode('connection reset')).toBeUndefined();
    expect(parseContractCode('Error(Auth, InvalidAction)')).toBeUndefined();
  });
});

describe('contract error table', () => {
  it('maps codes to names and back, including PaymentFailed', () => {
    expect(contractErrorName(7)).toBe('NotDue');
    expect(contractErrorName(10)).toBe('PaymentFailed');
    expect(contractErrorCode('NotDue')).toBe(7);
    expect(contractErrorCode('PaymentFailed')).toBe(10);
  });

  it('returns undefined for unknown codes and names', () => {
    expect(contractErrorName(99)).toBeUndefined();
    expect(contractErrorCode('NoSuchError')).toBeUndefined();
  });
});

describe('error classes', () => {
  it('SimulationError carries the contract code and name', () => {
    const e = new SimulationError('charge', new Error('HostError: Error(Contract, #7)'));
    expect(e).toBeInstanceOf(KeeperError);
    expect(e.code).toBe('SIMULATION_FAILED');
    expect(e.contractCode).toBe(7);
    expect(e.contractError).toBe('NotDue');
    expect(e.name).toBe('SimulationError');
  });

  it('SimulationError without a contract code leaves both fields undefined', () => {
    const e = new SimulationError('charge', 'budget exceeded');
    expect(e.contractCode).toBeUndefined();
    expect(e.contractError).toBeUndefined();
  });

  it('ContractCallError looks up the code from the name', () => {
    const e = new ContractCallError('read plan 1', 'PlanNotFound');
    expect(e.code).toBe('CONTRACT_ERROR');
    expect(e.contractCode).toBe(3);
  });

  it('describe turns unknown values into text', () => {
    expect(describeValue(new Error('x'))).toBe('x');
    expect(describeValue('y')).toBe('y');
    expect(describeValue(42)).toBe('unknown error');
  });

  it('describe cuts very long text, but keeps the start where the cause is', () => {
    const long = `HostError: Error(Contract, #7) ${'diagnostic line '.repeat(200)}`;
    const text = describeValue(new Error(long));
    expect(text.length).toBeLessThan(450);
    expect(text.startsWith('HostError: Error(Contract, #7)')).toBe(true);
    expect(text.endsWith('(cut)')).toBe(true);
    expect(describeValue('short')).toBe('short');
  });
});
