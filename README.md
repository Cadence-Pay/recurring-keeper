# recurring-keeper

Backend service for Stellar Recurring. It reads the recurring contract on Stellar, submits `charge` for subscriptions that are due, sends signed webhooks to merchants, and serves a read-only HTTP API. Charging is permissionless on the contract, so anyone can run a keeper.

This is **not** payment streaming. It is one discrete charge per period.

## Status

Implemented and covered by unit tests (`pnpm test`; 146 at the time of writing):

- sync of plans and subscriptions from the chain into SQLite,
- a charge loop with retries, backoff, a give-up rule and handling of a second keeper charging first,
- webhooks with HMAC-SHA256 signatures, retries and permanent-failure handling,
- a read API with an OpenAPI description,
- a per-transaction fee cap.

Run for real on the **testnet**: the built service, with a signing key and a fee cap, found a subscription due and charged it twice on its own (the second charge needed two retries after the public RPC timed out, exactly as designed), and its API matched the chain. The run is written up in the repository's `docs/DEMO.md`. Webhook delivery has only been tested against fake receivers, not a real merchant server. Nothing has run on mainnet.

**Audit status: the contract this service talks to has not been audited. This service has not been audited either.**

## Architecture

```
            Stellar RPC
                ^  reads (simulate), submits charge
                |
  +-------------+--------------------------------------------+
  |  keeper loop (every POLL_INTERVAL_SECS)                    |
  |   1. sync    copy new plans/subs, refresh active ones     |
  |   2. charge  for each due sub, one at a time              |
  |   3. deliver queued webhooks                              |
  |                         |                                  |
  |                      SQLite                                |
  |  plans, subscriptions, charges, webhook_deliveries, cursor |
  +---------+--------------------------------+-----------------+
            |                                |
     read API (fastify)               webhooks (HTTPS POST)
     GET only, JSON                   to each merchant
```

- **Source of truth is the chain.** The keeper reads `plan_count` / `sub_count` and `get_plan` / `get_subscription`. Events are not needed, because RPC keeps only about 7 days of events while state can always be read.
- **Sync** copies ids above its cursor in order and never skips a failing id. It then reads every active plan and subscription again to pick up charges, cancellations and deactivations.
- **Charging** keeps one record per subscription period (`charges` table) with its attempt count and next retry time, so waiting and retries survive a restart and never block other subscriptions. Submissions are sequential, because they share one account and parallel sends would collide on the sequence number.

## Run it

Needs Node 24 or newer and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env     # then fill in the values, see below
node --env-file=.env dist/main.js
```

Read only (no key) is the default and is a good first run: it syncs and serves the API but never submits.

Against the public testnet deployment recorded in the repository's `docs/TESTNET.md` (testnet is wiped on the dates listed there):

```bash
STELLAR_NETWORK=testnet \
STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
CONTRACT_ID=<contract id> \
node dist/main.js
curl localhost:8080/health
```

To let it charge, supply `KEEPER_SECRET_KEY` for a funded account **at run time**, from your secret store or shell. Do not write it to a file in the repository. The keeper account only pays transaction fees. It never holds subscribers' money.

Stop with Ctrl-C or SIGTERM: the loop finishes its current step, then the API and database close.

## Environment variables

Nothing network-specific is hard-coded: network, RPC URL and passphrase always come from the environment. `.env.example` lists every variable with empty values.

| Variable                           | Required | Meaning                                                                                                                                                                                          |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STELLAR_NETWORK`                  | yes      | Label such as `testnet` or `mainnet`. If it is one of those two, the passphrase must match it, which catches a testnet/mainnet mix-up.                                                           |
| `STELLAR_RPC_URL`                  | yes      | Stellar RPC endpoint (`http` or `https`).                                                                                                                                                        |
| `STELLAR_NETWORK_PASSPHRASE`       | yes      | Network passphrase used when signing.                                                                                                                                                            |
| `CONTRACT_ID`                      | yes      | The deployed recurring contract (starts with `C`).                                                                                                                                               |
| `KEEPER_SECRET_KEY`                | no       | Signing key. Without it the keeper is read only. Never logged.                                                                                                                                   |
| `READ_ONLY`                        | no       | `true` forbids submitting even if a key is set.                                                                                                                                                  |
| `MAX_FEE_STROOPS`                  | no       | Highest fee one charge may pay. A higher simulated fee, or an unknown fee, means the charge is not submitted. Unset means no limit.                                                              |
| `POLL_INTERVAL_SECS`               | no       | Seconds between passes. Default 15.                                                                                                                                                              |
| `DB_PATH`                          | no       | SQLite file. Default `./keeper.sqlite`.                                                                                                                                                          |
| `RPC_TIMEOUT_MS` / `TX_TIMEOUT_MS` | no       | Time for a read or simulation (default 30000) and for submitting and waiting for inclusion (default 60000).                                                                                      |
| `API_HOST` / `API_PORT`            | no       | Listen address. Default `127.0.0.1:8080`.                                                                                                                                                        |
| `CORS_ORIGINS`                     | no       | Comma-separated browser origins allowed to call the API, or `*`. Empty means no CORS headers.                                                                                                    |
| `WEBHOOK_CONFIG`                   | no       | JSON from merchant address to `{ "url", "secretEnv" }`. `secretEnv` names the variable holding that merchant's signing secret (16 characters or more). URLs must be `https`, except `localhost`. |

Empty values count as unset. A bad value stops the keeper at start with a message that names the variable and never repeats its value.

## Read API

`GET` only, JSON, no authentication (it serves public chain data as last synced). See [openapi.yaml](openapi.yaml).

| Route                             | Returns                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `/health`                         | status, network, contract id, `readOnly`, time of last finished sync |
| `/plans?merchant=&limit=&offset=` | plans                                                                |
| `/plans/:id`                      | one plan                                                             |
| `/plans/:id/subscriptions`        | subscriptions of a plan                                              |
| `/subscriptions/:id/charges`      | the keeper's charge records for a subscription                       |
| `/merchants/:address/revenue`     | per token: first payments plus every charge, whoever made it         |

Lists are paged (`limit` 1 to 200, default 50). Errors always look like `{ "error": { "code", "message" } }` with 400 for bad input, 404 for unknown ids and routes, and a generic 500. There is no rate limiting: put a reverse proxy in front if the API is public.

## Webhooks

For each merchant with an endpoint, the keeper POSTs JSON for `subscription.created`, `charge.succeeded`, `charge.failed` and `subscription.cancelled`:

```json
{
  "id": "<delivery id>",
  "type": "charge.succeeded",
  "createdAt": 1793883000,
  "data": {
    "merchant": "G...",
    "planId": 1,
    "subId": 2,
    "subscriber": "G...",
    "occurredAt": 1793883000,
    "token": "C...",
    "amount": "10000000",
    "txHash": "..."
  }
}
```

Headers: `X-Recurring-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw request body with the merchant's secret, `X-Recurring-Delivery` is the delivery id and `X-Recurring-Event` the type. Verify the signature against the raw bytes before parsing. A retry sends the same id and the same body, so use the id as an idempotency key. Payloads hold only addresses, ids, amounts, timestamps and status.

Delivery: a 2xx answer is success. Network errors, timeouts, 408, 429 and 5xx are retried 8 times in total, waiting 30 s doubling up to 1 hour. Any other answer, including redirects (which are not followed), fails the delivery at once. Logs never contain the secret, the signature, the body or the webhook URL.

On the very first sync of an empty database, existing subscriptions are not announced, so history is not replayed to merchants.

## Failure handling

| Situation                                                                                                     | What the keeper does                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Charge refused with `PaymentFailed` (balance or allowance too low or expired), RPC error, timeout, send error | Counts a failed attempt and retries after 30, 60, 120, 240 s. After 5 failures it marks the period `failed`, sends one `charge.failed` webhook, and starts a new round after 6 hours. The subscription stays active on chain. |
| `NotDue`, and the subscription's schedule moved                                                               | Another party charged first. Marked `superseded`. No failure.                                                                                                                                                                 |
| `NotDue`, schedule unchanged                                                                                  | The chain clock is behind. Retries in 15 s with no penalty.                                                                                                                                                                   |
| `NotActive`                                                                                                   | The subscription was cancelled. Marked `superseded`.                                                                                                                                                                          |
| Fee above `MAX_FEE_STROOPS`                                                                                   | Not submitted. Treated as a failed attempt, so it is retried later.                                                                                                                                                           |
| Webhook sink or delivery problem                                                                              | Logged. Never stops charging.                                                                                                                                                                                                 |
| RPC down during a pass                                                                                        | The pass is logged as failed and the next one runs.                                                                                                                                                                           |
| Restart                                                                                                       | Cursors, retry times and queued webhooks are in the database and resume.                                                                                                                                                      |

## What is not covered

- **Charges by other keepers** are counted in revenue (through `charges` on the subscription) but have no charge record or webhook here.
- **No dunning.** A failed charge only produces the `charge.failed` webhook (`WAVE-ISSUE(keeper-1)`).
- **No coordination with other keepers** (`WAVE-ISSUE(keeper-2)`), **no Postgres** (`WAVE-ISSUE(keeper-3)`), **no metrics endpoint** (`WAVE-ISSUE(keeper-4)`).
- **If no keeper runs, nobody is charged.** Monitor `lastSyncAt` on `/health`.
- **RPC limits.** Public RPC servers have rate limits and keep about 7 days of history. Use a provider with a key for anything serious.
- **Allowance expiry.** The token caps an allowance at about 180 days, so subscribers must renew it. The keeper reports the failure but cannot renew it.
- **One process.** Run a single keeper per database. Several keepers with separate databases are safe (the contract allows only one charge per period) but waste fees on the loser.

## Verify

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Two read-only tests against the deployed testnet contract run only with `LIVE_TESTNET=1`. They fail once testnet is reset and the contract is gone.

The files in `src/contract/` are generated by `stellar-js generate`; see the header in each file for how to regenerate them.

## License

MIT
