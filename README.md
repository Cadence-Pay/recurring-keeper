# recurring-keeper

Backend service for Stellar Recurring. Planned job: read the chain, submit due `charge` calls, send webhooks to merchants, and serve a read API. Charging is permissionless, so anyone can run a keeper.

This is **not** payment streaming. It is one discrete charge per period.

## Status

**Skeleton only.** It builds, lints and has one placeholder test. No chain access, charge loop, webhooks or API exist yet.

**Audit status: the contract this service talks to has not been audited. This service has not been audited either.**

## Verify

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Needs Node 24 or newer and pnpm.

## Configuration

`.env.example` lists the variables planned so far (network, RPC URL, passphrase). Nothing reads them yet. Never commit a real `.env`.

## License

MIT
