/**
 * An in-memory ChainClient for tests. It behaves like the contract where the keeper can see it:
 * counts, reads and a charge that follows the on-chain schedule rules. Not part of the build.
 */

import type { ChainClient, ChargeOutcome } from '../chain.js';
import type { Plan, Subscription } from '../contract/index.js';
import { ContractCallError, SimulationError } from '../errors.js';

export const MERCHANT = 'GAIPBT4WCBUALPT77TFYIK4LAHN67QNFM4OOTX3VEH4L6URNOUFJOTSQ';
export const SUBSCRIBER = 'GACJH7JXHQWIW66GHZFNMCK2I7WOZ562QAOF7B7PUENTAPRGC5RLW24A';
export const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** How the next call of a method should fail. */
export type Failure = Error | undefined;

export class FakeChain implements ChainClient {
  plans: Plan[] = [];
  subs: Subscription[] = [];
  /** Chain time in seconds, used by `charge`. */
  now = 1_000_000;
  /** Calls made to `charge`, in order. */
  chargeCalls: bigint[] = [];
  /** Errors thrown by reads of a given plan id. */
  planFailures = new Map<number, Error>();
  /** Errors thrown by reads of a given subscription id. */
  subFailures = new Map<number, Error>();
  /** If set, every `charge` rejects with this error. */
  chargeFailure: Failure;
  /** Per subscription: a queue of errors, consumed one per `charge` call. */
  chargeFailureQueue = new Map<number, Error[]>();
  private txCounter = 0;

  addPlan(overrides: Partial<Plan> = {}): number {
    this.plans.push({
      merchant: MERCHANT,
      token: TOKEN,
      amount: 10_000_000n,
      period_secs: 60n,
      active: true,
      ...overrides,
    });
    return this.plans.length;
  }

  addSub(planId: number, overrides: Partial<Subscription> = {}): number {
    this.subs.push({
      plan_id: BigInt(planId),
      subscriber: SUBSCRIBER,
      next_charge_ts: BigInt(this.now + 60),
      status: { tag: 'Active', values: undefined },
      charges: 0,
      ...overrides,
    });
    return this.subs.length;
  }

  cancelSub(id: number): void {
    const sub = this.sub(id);
    this.subs[id - 1] = { ...sub, status: { tag: 'Cancelled', values: undefined } };
  }

  deactivatePlan(id: number): void {
    const plan = this.plan(id);
    this.plans[id - 1] = { ...plan, active: false };
  }

  getPlanCount(): Promise<bigint> {
    return Promise.resolve(BigInt(this.plans.length));
  }

  getSubCount(): Promise<bigint> {
    return Promise.resolve(BigInt(this.subs.length));
  }

  getPlan(planId: bigint): Promise<Plan> {
    const id = Number(planId);
    const failure = this.planFailures.get(id);
    if (failure !== undefined) return Promise.reject(failure);
    const plan = this.plans[id - 1];
    if (plan === undefined) {
      return Promise.reject(new ContractCallError(`read plan ${String(id)}`, 'PlanNotFound'));
    }
    return Promise.resolve(plan);
  }

  getSubscription(subId: bigint): Promise<Subscription> {
    const id = Number(subId);
    const failure = this.subFailures.get(id);
    if (failure !== undefined) return Promise.reject(failure);
    const sub = this.subs[id - 1];
    if (sub === undefined) {
      return Promise.reject(
        new ContractCallError(`read subscription ${String(id)}`, 'SubNotFound'),
      );
    }
    return Promise.resolve(sub);
  }

  /** Mirrors the contract: NotActive, NotDue, then moves the schedule (no back-billing). */
  charge(subId: bigint): Promise<ChargeOutcome> {
    const id = Number(subId);
    this.chargeCalls.push(subId);
    const queued = this.chargeFailureQueue.get(id)?.shift();
    if (queued !== undefined) return Promise.reject(queued);
    if (this.chargeFailure !== undefined) return Promise.reject(this.chargeFailure);
    const sub = this.sub(id);
    if (sub.status.tag !== 'Active') {
      return Promise.reject(new SimulationError('charge', new Error('Error(Contract, #6)')));
    }
    if (BigInt(this.now) < sub.next_charge_ts) {
      return Promise.reject(new SimulationError('charge', new Error('Error(Contract, #7)')));
    }
    const period = this.plan(Number(sub.plan_id)).period_secs;
    const scheduled = sub.next_charge_ts + period;
    this.subs[id - 1] = {
      ...sub,
      charges: sub.charges + 1,
      next_charge_ts: scheduled <= BigInt(this.now) ? BigInt(this.now) + period : scheduled,
    };
    this.txCounter++;
    return Promise.resolve({ txHash: `tx${String(this.txCounter)}` });
  }

  private plan(id: number): Plan {
    const plan = this.plans[id - 1];
    if (plan === undefined) throw new Error(`no plan ${String(id)} in the fake chain`);
    return plan;
  }

  private sub(id: number): Subscription {
    const sub = this.subs[id - 1];
    if (sub === undefined) throw new Error(`no subscription ${String(id)} in the fake chain`);
    return sub;
  }
}
