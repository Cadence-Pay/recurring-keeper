import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { Client, Error as ContractError } from './index.js';

const CONTRACT_ID = 'CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E';

function makeClient(): Client {
  return new Client({
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
  });
}

describe('generated contract bindings', () => {
  it('describe all nine public contract functions', () => {
    const names = makeClient()
      .spec.funcs()
      .map((f) => f.name.toString())
      .sort();
    expect(names).toEqual([
      'cancel',
      'charge',
      'create_plan',
      'deactivate_plan',
      'get_plan',
      'get_subscription',
      'plan_count',
      'sub_count',
      'subscribe',
    ]);
  });

  it('map every contract error code, including PaymentFailed', () => {
    expect(ContractError[7].message).toBe('NotDue');
    expect(ContractError[10].message).toBe('PaymentFailed');
    expect(Object.keys(ContractError)).toHaveLength(10);
  });

  it('throw when asked for a function the contract does not have', () => {
    expect(() => makeClient().spec.getFunc('no_such_function')).toThrow();
  });
});
