# Verification guide: apps/agent

`apps/agent` is one Cloudflare Worker: the Edge, the Personal Agent Durable Object, and the Directory D1 binding. Terms follow [CONTEXT.md](../../CONTEXT.md).

## Verify a change

Run `pnpm verify` at the repository root. Turborepo runs the `verify` script of each workspace that the branch changed (`turbo run verify --affected`). To run only this workspace, run `pnpm --filter @repo/agent verify`.

The workspace `verify` script runs these checks in this order:

| Command | What it proves |
| --- | --- |
| `pnpm typecheck` | `worker-configuration.d.ts` matches `wrangler.jsonc` (`wrangler types --check`). The Worker code, the tests, and the control CLI type-check. |
| `pnpm test` | The behavior tests pass (see below). |
| `pnpm control bundle` | The Worker and the full stack probe build with a dry run and are below the Workers size limit. |

After a change to `wrangler.jsonc`, run `pnpm --filter @repo/agent types` and commit the new `worker-configuration.d.ts`.

The root lint rules let only `src/personal-agent` import the Agents SDK (decision 0003). Other modules use `personalAgentFor` and the `PersonalAgent` class.

## Behavior tests

Vitest runs two projects.

- `worker`: tests in `test/` run inside workerd with `@cloudflare/vitest-plugin`. They use real Durable Objects with SQLite storage and a real local D1 database. Each test file gets isolated storage.
- `control`: tests in `control/` run in Node and check the control CLI.

Local fixtures:

- No network. The test runtime answers every outbound `fetch` with status 503 and the text `Network is off in tests: <url>`. Remote bindings are off. A test proves this.
- Test secrets. `vitest.config.mts` sets fixed fake values for the required secrets. Tests never read `.dev.vars`.
- Loading the Agents SDK module graph is slow in the test runtime. The `worker` project pre-bundles `agents` and `effect` with the Vitest dependency optimizer. Tests import Worker modules at the top of the file, so the load happens while Vitest collects the file, not inside a test with a time limit. Call the Worker as `worker.fetch(request, env, createExecutionContext())`. Do not use `exports.default.fetch` in tests: its first call loads the module graph inside the test and can time out on a cold run.

What the tests prove now:

- A Personal Agent keeps one Effect runtime across requests (one runtime for each Durable Object, decision 0003).
- An Effect that runs in one Owner's Personal Agent reads and writes only that Owner's SQLite storage.
- The Directory D1 binding reads its own writes through a D1 session (decision 0006).
- The Edge answers 404 for a route that does not exist.
- `doctor` reports a complete configuration as healthy, names each missing secret, reports a Personal Agent without SQLite storage, and never prints a secret value.

## Control CLI

Run the commands from `apps/agent` with `pnpm control <command>`, or from the root with `pnpm --filter @repo/agent control <command>`.

| Command | What it does | Network |
| --- | --- | --- |
| `doctor` | Checks `wrangler.jsonc`: Worker name, entry, compatibility date, the `PERSONAL_AGENT` binding with SQLite storage, and the `DIRECTORY` D1 binding. Names each required secret as set or missing for local dev. It never prints a secret value. It exits with 1 when it finds a problem. | None |
| `dev` | Runs `wrangler dev --local` with local Durable Objects and a local D1 database in `.wrangler/state`. | None |
| `bundle` | Builds the Worker and the full stack probe with `wrangler deploy --dry-run`, then profiles startup with `wrangler check startup`. It exits with 1 when a bundle is over the size limit. | None |

`doctor` checks local secrets the same way as `wrangler dev`: from `.dev.vars`, or else from `.env` files and the shell environment. It does not check the secrets of a deployed Instance.

Commands that come with later slices: `owner add`, `request --contains`, and `webhook set`.

## Secrets

`wrangler.jsonc` lists the required Worker secrets in `secrets.required`. This list is the only source of secret names.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `AI_GATEWAY_TOKEN`

For local dev, put them in `apps/agent/.dev.vars`. Git ignores this file. Never commit, log, or paste secret values. Deploying and setting secrets on Cloudflare need the repository owner's approval (decision 0002).

## Bundle size and startup

Measured on 2026-11-13 with `pnpm control bundle` (wrangler 4.162.0, Agents SDK 0.33.0, Effect 4.1.4, AI SDK 7.0.172).

| Entry | Size (uncompressed) | gzip (not limited) | Local startup CPU |
| --- | --- | --- | --- |
| Worker (`src/index.ts`) | 2,432.58 KiB | 452.27 KiB | 156 to 231 ms |
| Full stack probe (`bundle/full-stack.ts`) | 3,768.32 KiB | 712.14 KiB | 194 to 499 ms |

Limits from the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/), read on 2026-11-13:

- Worker size: 64 MiB uncompressed, on the Free and the Paid plan. There is no compressed size limit. The 3 MB figure in the [feasibility study](../research/2026-11-12-cloudflare-feasibility.md) is out of date.
- Startup: the global scope must parse and run within 1 second.
- CPU time: 10 ms for each HTTP request on the Free plan. Waiting for network I/O does not count.

Result: the full stack uses 5.8% of the size limit. It fits the free plan for bundle size.

The full stack probe is the real Worker plus the AI SDK with an OpenAI-compatible provider for the AI Gateway, and Effect Schema. It measures the stack before the Turn uses these libraries. When the Worker itself uses them, the Worker measurement includes them.

Most of the Worker size comes from the Agents SDK and its dependencies: zod (765 KiB), the Agents SDK (612 KiB), the MCP client (444 KiB), and mime-db (208 KiB). Effect adds 139 KiB.

Startup CPU is measured on the local machine, which has a different CPU from Cloudflare. The numbers changed between runs on a shared machine, so `bundle` shows them but does not enforce them. The CPU time for each webhook request and each alarm Turn needs the deployed Worker and is measured in the live slice.
