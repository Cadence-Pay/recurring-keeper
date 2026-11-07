# Contributing to recurring-keeper

Thank you for helping. This is the keeper service of Stellar Recurring: pull-based subscription billing on Stellar. One discrete charge per period; it is **not** payment streaming.

The keeper holds a signing key. It only pays transaction fees, but a leaked key is still a loss.

## Set up

You need Node 24 or newer and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Cadence-Pay/recurring-keeper.git
cd recurring-keeper
pnpm install --frozen-lockfile
pnpm test
```

## Before you open a pull request

Run the full check. A pull request is ready when this passes:

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Rules for this package:

- TypeScript is strict. No `any`. Errors are typed classes with a stable `code`, not strings.
- Validate everything that comes from outside (environment, HTTP input, webhooks) with a schema.
- Never log or store a secret: not the signing key, not webhook secrets, not signatures, not full webhook URLs.
- Charges are submitted one at a time on purpose (one account, one sequence number). Do not parallelise them.
- Every public function has a test for success and at least one for failure. Chain access is behind `ChainClient` and storage behind `Store`, so tests use fakes (see `src/testing/`).
- `src/contract/` is generated. Do not edit it by hand; see the header in each file to regenerate it.

Where things are: `src/` (service), `openapi.yaml` (read API), `README.md` (configuration and failure handling).

General rules:

- **Testnet only.** Never put a mainnet key, a seed phrase or any secret in a file, a test, a log, a commit or an issue. Use the Stellar CLI key store.
- **Describe only what exists.** Documentation says what is implemented and tested. No claims about features that are not there.
- **Keep to the issue.** Do what the issue asks and no more. A small, focused change is reviewed faster than a large one.
- **Test it.** New behaviour comes with tests for success and for failure. Say in the pull request what you ran.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org). Examples:

```
feat(keeper): add <what>
fix(keeper): handle <case>
docs(keeper): explain <thing>
test(keeper): cover <case>
```

## Claiming an issue

1. Pick an issue that is not assigned. Issues drafted for contributors name a marker such as `WAVE-ISSUE(...)`; search the code for it to find where the work plugs in.
2. Comment that you would like to take it, and wait to be assigned. One person per issue at a time.
3. Ask questions in the issue if the scope is unclear. The scope written there is the limit of the change.
4. Open a pull request that mentions the issue. If you stop working on it, say so, so someone else can take it.

If an issue carries a Drips Wave label (for example `Stellar Wave`), it is part of a [Drips Wave](https://www.drips.network/wave) cycle. Apply for it in the Drips Wave app; the maintainers assign one applicant, there or on GitHub.

## Reporting a security problem

Do not open a public issue. See [SECURITY.md](SECURITY.md).

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
