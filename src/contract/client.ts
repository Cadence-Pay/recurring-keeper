/**
 * GENERATED FILE. Do not edit by hand.
 *
 * Typed bindings for the recurring-contracts Soroban contract.
 * Generated 2026-11-05 with:
 *   stellar-js generate --contract-id CCUXOGU3N5HWMLRDXC5TCQ3QDA23X3RJCDXWHMBIC4SFLD2IABQT465E \
 *     --network testnet --output-dir ./src/contract --contract-name recurring-contracts
 * using @stellar/stellar-sdk 17.4.0, from the contract deployed on testnet with wasm hash
 * dde9e953b6c94497f390ae99318a77f6f3937dacd260434648747c8183e68e3c
 * (recurring-contracts source commit ade108a, see https://github.com/Cadence-Pay/recurring-contracts/blob/main/docs/TESTNET.md).
 * To regenerate after a contract change, rerun the command with the new contract id and
 * update this header. The package.json, tsconfig.json and README the generator also writes
 * were removed because the files live inside the keeper package.
 */
import {Plan, Subscription, ContractEvent} from './types.js';
import {Result, Spec, AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions, ExternalExecutableRef} from '@stellar/stellar-sdk/contract';
import {Address, xdr} from '@stellar/stellar-sdk';

export interface Client {
  /**
   * Cancel a subscription. Only the subscriber or the plan's merchant may do so.
   *
   * `caller` must authorize the call and must be one of the two parties (`NotAuthorized`
   * otherwise). A cancelled subscription is never charged again (`NotActive`). Cancelling does
   * not touch the token allowance. The subscriber can revoke it at the token.
   */
  cancel(args: { caller: string | Address; sub_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Charge one period. Permissionless: any account may call it once the subscription is due.
   *
   * Requires an `Active` subscription (`NotActive` otherwise) and `now >= next_charge_ts`
   * (`NotDue` otherwise). Moves the plan amount from the subscriber to the merchant with
   * `transfer_from`, spending the allowance the subscriber gave this contract. The contract is
   * the spender and the invoker, so the caller does not need to authorize anything.
   *
   * The next due time follows decision D2 (no back-billing): `next_charge_ts + period_secs`,
   * or `now + period_secs` if that is not in the future. At most one charge happens per call.
   *
   * If the token call fails (no allowance, expired allowance, low balance) the call returns
   * `PaymentFailed`, the whole call reverts and nothing changes.
   */
  charge(args: { sub_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Read a plan.
   */
  get_plan(args: { plan_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<Plan, Error>>>;
  /**
   * Number of subscriptions created so far. Ids run from 1 to this value.
   */
  sub_count(options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
  /**
   * Subscribe and pay the first period now. Requires the subscriber's authorization.
   * Returns the new subscription id.
   *
   * The first period is paid with a direct `transfer` from the subscriber to the merchant, so
   * no allowance is needed for it. The next charge is due one period from now. If the token
   * transfer fails (for example the balance is too low) the call returns `PaymentFailed` and
   * the whole call reverts.
   *
   * Fails with `PlanNotFound` or `PlanInactive` if the plan cannot take subscriptions.
   */
  subscribe(args: { subscriber: string | Address; plan_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  /**
   * Number of plans created so far. Ids run from 1 to this value.
   */
  plan_count(options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
  /**
   * Create a plan. Requires the merchant's authorization. Returns the new plan id.
   *
   * Fails with `InvalidAmount` if `amount <= 0` and with `InvalidPeriod` if `period_secs` is
   * outside `MIN_PERIOD_SECS..=MAX_PERIOD_SECS`.
   */
  create_plan(args: { merchant: string | Address; token: string | Address; amount: bigint; period_secs: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<bigint, Error>>>;
  /**
   * Stop accepting new subscriptions to a plan. Requires the plan merchant's authorization.
   * Existing subscriptions keep working. Deactivating an inactive plan does nothing.
   */
  deactivate_plan(args: { plan_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, Error>>>;
  /**
   * Read a subscription.
   */
  get_subscription(args: { sub_id: bigint }, options?: MethodOptions): Promise<AssembledTransaction<Result<Subscription, Error>>>;
}

export class Client extends ContractClient {
  constructor(public readonly options: ContractClientOptions) {
    super(
      new Spec(["AAAAAAAAAUdDYW5jZWwgYSBzdWJzY3JpcHRpb24uIE9ubHkgdGhlIHN1YnNjcmliZXIgb3IgdGhlIHBsYW4ncyBtZXJjaGFudCBtYXkgZG8gc28uCgpgY2FsbGVyYCBtdXN0IGF1dGhvcml6ZSB0aGUgY2FsbCBhbmQgbXVzdCBiZSBvbmUgb2YgdGhlIHR3byBwYXJ0aWVzIChgTm90QXV0aG9yaXplZGAKb3RoZXJ3aXNlKS4gQSBjYW5jZWxsZWQgc3Vic2NyaXB0aW9uIGlzIG5ldmVyIGNoYXJnZWQgYWdhaW4gKGBOb3RBY3RpdmVgKS4gQ2FuY2VsbGluZyBkb2VzCm5vdCB0b3VjaCB0aGUgdG9rZW4gYWxsb3dhbmNlLiBUaGUgc3Vic2NyaWJlciBjYW4gcmV2b2tlIGl0IGF0IHRoZSB0b2tlbi4AAAAABmNhbmNlbAAAAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAZzdWJfaWQAAAAAAAYAAAABAAAD6QAAAAIAAAAD", "AAAAAAAAAvlDaGFyZ2Ugb25lIHBlcmlvZC4gUGVybWlzc2lvbmxlc3M6IGFueSBhY2NvdW50IG1heSBjYWxsIGl0IG9uY2UgdGhlIHN1YnNjcmlwdGlvbiBpcyBkdWUuCgpSZXF1aXJlcyBhbiBgQWN0aXZlYCBzdWJzY3JpcHRpb24gKGBOb3RBY3RpdmVgIG90aGVyd2lzZSkgYW5kIGBub3cgPj0gbmV4dF9jaGFyZ2VfdHNgCihgTm90RHVlYCBvdGhlcndpc2UpLiBNb3ZlcyB0aGUgcGxhbiBhbW91bnQgZnJvbSB0aGUgc3Vic2NyaWJlciB0byB0aGUgbWVyY2hhbnQgd2l0aApgdHJhbnNmZXJfZnJvbWAsIHNwZW5kaW5nIHRoZSBhbGxvd2FuY2UgdGhlIHN1YnNjcmliZXIgZ2F2ZSB0aGlzIGNvbnRyYWN0LiBUaGUgY29udHJhY3QgaXMKdGhlIHNwZW5kZXIgYW5kIHRoZSBpbnZva2VyLCBzbyB0aGUgY2FsbGVyIGRvZXMgbm90IG5lZWQgdG8gYXV0aG9yaXplIGFueXRoaW5nLgoKVGhlIG5leHQgZHVlIHRpbWUgZm9sbG93cyBkZWNpc2lvbiBEMiAobm8gYmFjay1iaWxsaW5nKTogYG5leHRfY2hhcmdlX3RzICsgcGVyaW9kX3NlY3NgLApvciBgbm93ICsgcGVyaW9kX3NlY3NgIGlmIHRoYXQgaXMgbm90IGluIHRoZSBmdXR1cmUuIEF0IG1vc3Qgb25lIGNoYXJnZSBoYXBwZW5zIHBlciBjYWxsLgoKSWYgdGhlIHRva2VuIGNhbGwgZmFpbHMgKG5vIGFsbG93YW5jZSwgZXhwaXJlZCBhbGxvd2FuY2UsIGxvdyBiYWxhbmNlKSB0aGUgY2FsbCByZXR1cm5zCmBQYXltZW50RmFpbGVkYCwgdGhlIHdob2xlIGNhbGwgcmV2ZXJ0cyBhbmQgbm90aGluZyBjaGFuZ2VzLgAAAAAAAAZjaGFyZ2UAAAAAAAEAAAAAAAAABnN1Yl9pZAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=", "AAAAAAAAAAxSZWFkIGEgcGxhbi4AAAAIZ2V0X3BsYW4AAAABAAAAAAAAAAdwbGFuX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAEUGxhbgAAAAM=", "AAAAAAAAAEVOdW1iZXIgb2Ygc3Vic2NyaXB0aW9ucyBjcmVhdGVkIHNvIGZhci4gSWRzIHJ1biBmcm9tIDEgdG8gdGhpcyB2YWx1ZS4AAAAAAAAJc3ViX2NvdW50AAAAAAAAAAAAAAEAAAAG", "AAAAAAAAAelTdWJzY3JpYmUgYW5kIHBheSB0aGUgZmlyc3QgcGVyaW9kIG5vdy4gUmVxdWlyZXMgdGhlIHN1YnNjcmliZXIncyBhdXRob3JpemF0aW9uLgpSZXR1cm5zIHRoZSBuZXcgc3Vic2NyaXB0aW9uIGlkLgoKVGhlIGZpcnN0IHBlcmlvZCBpcyBwYWlkIHdpdGggYSBkaXJlY3QgYHRyYW5zZmVyYCBmcm9tIHRoZSBzdWJzY3JpYmVyIHRvIHRoZSBtZXJjaGFudCwgc28Kbm8gYWxsb3dhbmNlIGlzIG5lZWRlZCBmb3IgaXQuIFRoZSBuZXh0IGNoYXJnZSBpcyBkdWUgb25lIHBlcmlvZCBmcm9tIG5vdy4gSWYgdGhlIHRva2VuCnRyYW5zZmVyIGZhaWxzIChmb3IgZXhhbXBsZSB0aGUgYmFsYW5jZSBpcyB0b28gbG93KSB0aGUgY2FsbCByZXR1cm5zIGBQYXltZW50RmFpbGVkYCBhbmQKdGhlIHdob2xlIGNhbGwgcmV2ZXJ0cy4KCkZhaWxzIHdpdGggYFBsYW5Ob3RGb3VuZGAgb3IgYFBsYW5JbmFjdGl2ZWAgaWYgdGhlIHBsYW4gY2Fubm90IHRha2Ugc3Vic2NyaXB0aW9ucy4AAAAAAAAJc3Vic2NyaWJlAAAAAAAAAgAAAAAAAAAKc3Vic2NyaWJlcgAAAAAAEwAAAAAAAAAHcGxhbl9pZAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==", "AAAAAAAAAD1OdW1iZXIgb2YgcGxhbnMgY3JlYXRlZCBzbyBmYXIuIElkcyBydW4gZnJvbSAxIHRvIHRoaXMgdmFsdWUuAAAAAAAACnBsYW5fY291bnQAAAAAAAAAAAABAAAABg==", "AAAAAAAAANVDcmVhdGUgYSBwbGFuLiBSZXF1aXJlcyB0aGUgbWVyY2hhbnQncyBhdXRob3JpemF0aW9uLiBSZXR1cm5zIHRoZSBuZXcgcGxhbiBpZC4KCkZhaWxzIHdpdGggYEludmFsaWRBbW91bnRgIGlmIGBhbW91bnQgPD0gMGAgYW5kIHdpdGggYEludmFsaWRQZXJpb2RgIGlmIGBwZXJpb2Rfc2Vjc2AgaXMKb3V0c2lkZSBgTUlOX1BFUklPRF9TRUNTLi49TUFYX1BFUklPRF9TRUNTYC4AAAAAAAALY3JlYXRlX3BsYW4AAAAABAAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAALcGVyaW9kX3NlY3MAAAAABgAAAAEAAAPpAAAABgAAAAM=", "AAAAAAAAAKhTdG9wIGFjY2VwdGluZyBuZXcgc3Vic2NyaXB0aW9ucyB0byBhIHBsYW4uIFJlcXVpcmVzIHRoZSBwbGFuIG1lcmNoYW50J3MgYXV0aG9yaXphdGlvbi4KRXhpc3Rpbmcgc3Vic2NyaXB0aW9ucyBrZWVwIHdvcmtpbmcuIERlYWN0aXZhdGluZyBhbiBpbmFjdGl2ZSBwbGFuIGRvZXMgbm90aGluZy4AAAAPZGVhY3RpdmF0ZV9wbGFuAAAAAAEAAAAAAAAAB3BsYW5faWQAAAAABgAAAAEAAAPpAAAAAgAAAAM=", "AAAAAAAAABRSZWFkIGEgc3Vic2NyaXB0aW9uLgAAABBnZXRfc3Vic2NyaXB0aW9uAAAAAQAAAAAAAAAGc3ViX2lkAAAAAAAGAAAAAQAAA+kAAAfQAAAADFN1YnNjcmlwdGlvbgAAAAM=", "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACgAAABtBbW91bnQgaXMgemVybyBvciBuZWdhdGl2ZS4AAAAADUludmFsaWRBbW91bnQAAAAAAAABAAAANFBlcmlvZCBpcyBvdXRzaWRlIE1JTl9QRVJJT0RfU0VDUy4uPU1BWF9QRVJJT0RfU0VDUy4AAAANSW52YWxpZFBlcmlvZAAAAAAAAAIAAAAAAAAADFBsYW5Ob3RGb3VuZAAAAAMAAAA6VGhlIHBsYW4gd2FzIGRlYWN0aXZhdGVkIGFuZCBhY2NlcHRzIG5vIG5ldyBzdWJzY3JpcHRpb25zLgAAAAAADFBsYW5JbmFjdGl2ZQAAAAQAAAAAAAAAC1N1Yk5vdEZvdW5kAAAAAAUAAAAeVGhlIHN1YnNjcmlwdGlvbiBpcyBjYW5jZWxsZWQuAAAAAAAJTm90QWN0aXZlAAAAAAAABgAAACpUaGUgbmV4dCBjaGFyZ2UgdGltZSBoYXMgbm90IGJlZW4gcmVhY2hlZC4AAAAAAAZOb3REdWUAAAAAAAcAAAAnVGhlIGNhbGxlciBtYXkgbm90IHBlcmZvcm0gdGhpcyBhY3Rpb24uAAAAAA1Ob3RBdXRob3JpemVkAAAAAAAACAAAACNBbiBhcml0aG1ldGljIG9wZXJhdGlvbiBvdmVyZmxvd2VkLgAAAAAIT3ZlcmZsb3cAAAAJAAAA/1RoZSB0b2tlbiB0cmFuc2ZlciBmYWlsZWQ6IGJhbGFuY2UgdG9vIGxvdywgYWxsb3dhbmNlIHRvbyBsb3cgb3IgZXhwaXJlZCwgb3IgdGhlIHRva2VuCnJlZnVzZWQuIFdpdGhvdXQgdGhpcywgdGhlIHRva2VuJ3Mgb3duIGVycm9yIGNvZGUgd291bGQgcGFzcyB0aHJvdWdoIGFuZCBjb3VsZCBiZSByZWFkIGFzCm9uZSBvZiB0aGUgY29kZXMgYWJvdmUgKGZvciBleGFtcGxlIHRoZSB0b2tlbidzIGNvZGUgOSBsb29rcyBsaWtlIGBPdmVyZmxvd2ApLgAAAAANUGF5bWVudEZhaWxlZAAAAAAAAAo=", "AAAAAQAAACVBIGJpbGxpbmcgcGxhbiBjcmVhdGVkIGJ5IGEgbWVyY2hhbnQuAAAAAAAAAAAAAARQbGFuAAAABQAAAElGYWxzZSBvbmNlIGRlYWN0aXZhdGVkLiBObyBuZXcgc3Vic2NyaXB0aW9ucywgZXhpc3Rpbmcgb25lcyBrZWVwIHdvcmtpbmcuAAAAAAAABmFjdGl2ZQAAAAAAAQAAADBBbW91bnQgcGVyIHBlcmlvZCwgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4AAAAGYW1vdW50AAAAAAALAAAAM1JlY2VpdmVzIGV2ZXJ5IHBheW1lbnQgYW5kIG1heSBkZWFjdGl2YXRlIHRoZSBwbGFuLgAAAAAIbWVyY2hhbnQAAAATAAAAKExlbmd0aCBvZiBvbmUgYmlsbGluZyBwZXJpb2QgaW4gc2Vjb25kcy4AAAALcGVyaW9kX3NlY3MAAAAABgAAAChTRVAtNDEgdG9rZW4gY29udHJhY3QgdXNlZCBmb3IgcGF5bWVudHMuAAAABXRva2VuAAAAAAAAEw==", "AAAAAgAAACJMaWZlY3ljbGUgc3RhdGUgb2YgYSBzdWJzY3JpcHRpb24uAAAAAAAAAAAACVN1YlN0YXR1cwAAAAAAAAIAAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAAAAAAAAAAACUNhbmNlbGxlZAAAAA==", "AAAAAQAAACZBIHN1YnNjcmliZXIncyBzdWJzY3JpcHRpb24gdG8gYSBwbGFuLgAAAAAAAAAAAAxTdWJzY3JpcHRpb24AAAAFAAAAR051bWJlciBvZiBzdWNjZXNzZnVsIGNoYXJnZXMgYWZ0ZXIgdGhlIGZpcnN0IHBheW1lbnQgbWFkZSBhdCBzdWJzY3JpYmUuAAAAAAdjaGFyZ2VzAAAAAAQAAABBTGVkZ2VyIHRpbWVzdGFtcCAoc2Vjb25kcykgZnJvbSB3aGljaCB0aGUgbmV4dCBjaGFyZ2UgaXMgYWxsb3dlZC4AAAAAAAAObmV4dF9jaGFyZ2VfdHMAAAAAAAYAAAAAAAAAB3BsYW5faWQAAAAABgAAAAAAAAAGc3RhdHVzAAAAAAfQAAAACVN1YlN0YXR1cwAAAAAAAAAAAAAKc3Vic2NyaWJlcgAAAAAAEw==", "AAAABQAAAAAAAAAAAAAAB0NoYXJnZWQAAAAAAQAAAAdjaGFyZ2VkAAAAAAYAAAAAAAAABnN1Yl9pZAAAAAAABgAAAAEAAAAAAAAAB3BsYW5faWQAAAAABgAAAAEAAAAAAAAACnN1YnNjcmliZXIAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAARVRvdGFsIHN1Y2Nlc3NmdWwgY2hhcmdlcyBhZnRlciB0aGUgZmlyc3QgcGF5bWVudCwgaW5jbHVkaW5nIHRoaXMgb25lLgAAAAAAAAdjaGFyZ2VzAAAAAAQAAAAAAAAAAAAAAA5uZXh0X2NoYXJnZV90cwAAAAAABgAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAACUNhbmNlbGxlZAAAAAAAAAEAAAAJY2FuY2VsbGVkAAAAAAAABAAAAAAAAAAGc3ViX2lkAAAAAAAGAAAAAQAAAAAAAAAHcGxhbl9pZAAAAAAGAAAAAQAAAAAAAAAKc3Vic2NyaWJlcgAAAAAAEwAAAAEAAAAkVGhlIHN1YnNjcmliZXIgb3IgdGhlIHBsYW4gbWVyY2hhbnQuAAAADGNhbmNlbGxlZF9ieQAAABMAAAAAAAAAAg==", "AAAABQAAAAAAAAAAAAAAClN1YnNjcmliZWQAAAAAAAEAAAAKc3Vic2NyaWJlZAAAAAAABQAAAAAAAAAGc3ViX2lkAAAAAAAGAAAAAQAAAAAAAAAHcGxhbl9pZAAAAAAGAAAAAQAAAAAAAAAKc3Vic2NyaWJlcgAAAAAAEwAAAAEAAAAlQW1vdW50IHBhaWQgbm93IGZvciB0aGUgZmlyc3QgcGVyaW9kLgAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAA5uZXh0X2NoYXJnZV90cwAAAAAABgAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAAC1BsYW5DcmVhdGVkAAAAAAEAAAAMcGxhbl9jcmVhdGVkAAAABQAAAAAAAAAHcGxhbl9pZAAAAAAGAAAAAQAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAALcGVyaW9kX3NlY3MAAAAABgAAAAAAAAAC", "AAAABQAAAAAAAAAAAAAAD1BsYW5EZWFjdGl2YXRlZAAAAAABAAAAEHBsYW5fZGVhY3RpdmF0ZWQAAAACAAAAAAAAAAdwbGFuX2lkAAAAAAYAAAABAAAAAAAAAAhtZXJjaGFudAAAABMAAAABAAAAAg=="]),
      options
    );
  }

   static deploy<T = Client>(options: MethodOptions & Omit<ContractClientOptions, 'contractId'> & { salt?: Uint8Array; address?: string; } & ({ wasmHash: Uint8Array | string; format?: "hex" | "base64"; externalRef?: never; } | { externalRef: ExternalExecutableRef; wasmHash?: never; format?: never; })): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options);
  }
  public readonly fromJson = {
    cancel : this.txFromJson<Result<null, Error>>,  charge : this.txFromJson<Result<null, Error>>,  get_plan : this.txFromJson<Result<Plan, Error>>,  sub_count : this.txFromJson<bigint>,  subscribe : this.txFromJson<Result<bigint, Error>>,  plan_count : this.txFromJson<bigint>,  create_plan : this.txFromJson<Result<bigint, Error>>,  deactivate_plan : this.txFromJson<Result<null, Error>>,  get_subscription : this.txFromJson<Result<Subscription, Error>>
  };

  /** @deprecated Use fromJson instead. */
  public readonly fromJSON = this.fromJson;

  /**
   * Parse a raw contract event (topics + data) into a typed {@link ContractEvent}.
   */
  parseEvent(topics: xdr.ScVal[] | string[], data: xdr.ScVal | string): ContractEvent | undefined {
    return this.spec.parseEvent(topics, data) as ContractEvent | undefined;
  }
  /**
   * Build a topics filter row for the "Charged" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  chargedEventFilter(topicValues?: { sub_id?: bigint; plan_id?: bigint; subscriber?: string | Address }): string[] {
    return this.spec.eventTopicFilter("Charged", topicValues);
  }
  /**
   * Build a topics filter row for the "Cancelled" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  cancelledEventFilter(topicValues?: { sub_id?: bigint; plan_id?: bigint; subscriber?: string | Address }): string[] {
    return this.spec.eventTopicFilter("Cancelled", topicValues);
  }
  /**
   * Build a topics filter row for the "Subscribed" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  subscribedEventFilter(topicValues?: { sub_id?: bigint; plan_id?: bigint; subscriber?: string | Address }): string[] {
    return this.spec.eventTopicFilter("Subscribed", topicValues);
  }
  /**
   * Build a topics filter row for the "PlanCreated" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  planCreatedEventFilter(topicValues?: { plan_id?: bigint; merchant?: string | Address }): string[] {
    return this.spec.eventTopicFilter("PlanCreated", topicValues);
  }
  /**
   * Build a topics filter row for the "PlanDeactivated" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  planDeactivatedEventFilter(topicValues?: { plan_id?: bigint; merchant?: string | Address }): string[] {
    return this.spec.eventTopicFilter("PlanDeactivated", topicValues);
  }
}
