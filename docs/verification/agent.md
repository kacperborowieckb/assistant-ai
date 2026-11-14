# Verification guide: apps/agent

`apps/agent` is one Cloudflare Worker: the Edge, the Personal Agent Durable Object, and the Directory D1 binding. Terms follow [CONTEXT.md](../../CONTEXT.md).

## Message flow

1. Telegram sends an update to `POST /telegram/webhook`. The Edge checks the `X-Telegram-Bot-Api-Secret-Token` header and keeps only text messages from private chats.
2. The Edge finds the Owner for the Channel Identity `telegram:<user id>` through the Directory. It reads with a D1 session.
3. The Edge gives the Event to the Owner's Personal Agent. The Personal Agent stores the Event in its Inbox, writes an `EventReceived` Journal Entry, and schedules a Turn with the Agents SDK `schedule`, which uses a durable alarm. Then the Edge answers 200.
4. The alarm runs a Turn for each pending Event, oldest first. The Turn reads the recent conversation and asks the Model Gateway for a reply to that Event. The Model Gateway records Usage. Burst merge is not in this slice.
5. The Turn writes `ReplyPlanned`, then sends the reply with Telegram `sendMessage`. It writes `ReplySent` only with the Telegram message id. A refused or failed send writes `ReplyFailed`, and the Events are failed.

The Operator adds the Owner with `POST /operator/owners`. This route needs `Authorization: Bearer <OPERATOR_TOKEN>` and writes through the Directory interface. It does not open Registration.

## Verify a change

Run `pnpm verify` at the repository root. Turborepo runs the `verify` script of each workspace that the branch changed (`turbo run verify --affected`). To run only this workspace, run `pnpm --filter @repo/agent verify`.

The workspace `verify` script runs these checks in this order:

| Command | What it proves |
| --- | --- |
| `pnpm typecheck` | `worker-configuration.d.ts` matches `wrangler.jsonc` (`wrangler types --check`). The Worker code, the tests, and the control CLI type-check. |
| `pnpm test` | The behavior tests pass (see below). |
| `pnpm control bundle` | The Worker builds with a dry run and is below the Workers size limit. |

After a change to `wrangler.jsonc`, run `pnpm --filter @repo/agent types` and commit the new `worker-configuration.d.ts`.

The root lint rules let only `src/personal-agent` import the Agents SDK (decision 0003). Other modules use `personalAgentFor` and the `PersonalAgent` class.

## Behavior tests

Vitest runs two projects.

- `worker`: tests in `test/` run inside workerd with `@cloudflare/vitest-plugin`. They use real Durable Objects with SQLite storage and a real local D1 database. Each test file gets isolated storage.
- `control`: tests in `control/` run in Node and check the control CLI.

Local fixtures:

- Test Worker entry. `test/worker.ts` exports the real Edge and a `PersonalAgent` subclass. The subclass gives the Turn a fake model from the AI SDK test utilities (`MockLanguageModelV4`) and the real Telegram Channel with a fake Telegram API `fetch`. Both fakes are in `test/fakes.ts`, and they record each call. The real Model Gateway, Inbox, Journal, and Usage code runs.
- Directory migrations. `test/apply-migrations.ts` applies `src/directory/migrations` to the test D1 database before each test file.
- No network. The test runtime answers every outbound `fetch` with status 503 and the text `Network is off in tests: <url>`. Remote bindings are off. A test proves this.
- Test secrets. `vitest.config.mts` sets fixed fake values for the required secrets. Tests never read `.dev.vars`.
- Loading the Agents SDK module graph is slow in the test runtime. The `worker` project pre-bundles `agents` and `effect` with the Vitest dependency optimizer. Tests import Worker modules at the top of the file, so the load happens while Vitest collects the file, not inside a test with a time limit. Call the Worker as `worker.fetch(request, env, createExecutionContext())`. Do not use `exports.default.fetch` in tests: its first call loads the module graph inside the test and can time out on a cold run.

What the tests prove now:

- The Operator route adds the Owner and the Channel Identity through the Directory, and Registration stays closed. A request without the Operator token gets 401 and stores nothing. A Channel Identity that already has an Owner gets 409.
- A text message from the Owner is in the Inbox when the webhook answers 200, while the fake model still holds the Turn. The alarm then runs the Turn, and the fake Telegram API gets exactly one `sendMessage`: plain text, to the Owner's chat, as a reply to the Owner's message.
- The prompt has the static system part first, then the conversation, then the new message.
- Each Turn writes `EventReceived`, `ReplyPlanned`, and `ReplySent` Journal Entries for the Owner, and one Usage row with input, output, and cached tokens.
- A send that Telegram refuses writes `ReplyFailed` and never `ReplySent`.
- The Journal storage refuses updates and deletes, and entries stay the same after a later Turn.
- The Model Gateway calls `<AI Gateway URL>/chat/completions` with `cf-aig-gateway-id`, the Owner Id in `cf-aig-metadata`, and `cf-aig-collect-log-payload: false`.
- A missing Turn configuration names the missing value and does not show a secret value.
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
| `dev` | Applies the Directory migrations to local D1, starts a fake Telegram API and a fake AI Gateway on `127.0.0.1`, and runs `wrangler dev --local` with local Durable Objects and D1 in `.wrangler/state`. It sets `TELEGRAM_API_URL` and `AI_GATEWAY_URL` to the fakes and prints each fake `sendMessage`. | None |
| `owner add --telegram-user <id> [--url <Worker URL>]` | Adds the Owner and the Channel Identity through the Operator route, which writes through the Directory. The default URL is the local Worker of `dev`. It reads `OPERATOR_TOKEN` from the environment, or else from `.dev.vars`. | The Worker at `--url` |
| `request --contains <text> [--message <text>]` | Starts the real Worker with temporary storage, random secrets, a fake Telegram API, and a fake model. Adds an Owner, sends a sample Telegram text message to the webhook, and waits for the fake `sendMessage`. It exits with 1 when the reply does not contain the text. The fake model answers `You said: <message>`. | None |
| `bundle` | Builds the Worker with `wrangler deploy --dry-run`, then profiles startup with `wrangler check startup`. It exits with 1 when the bundle is over the size limit. | None |

`doctor` checks local secrets the same way as `wrangler dev`: from `.dev.vars`, or else from `.env` files and the shell environment. It does not check the secrets of a deployed Instance.

Example local proof:

```sh
pnpm control request --contains "You said: Hello agent"
```

`owner add` with `--url` set to a deployed Instance changes production data. It needs the repository owner's approval (decision 0002). `webhook set` comes with the live slice.

## Configuration

`wrangler.jsonc` `vars`:

- `TELEGRAM_API_URL`: the Telegram Bot API origin. `dev` and `request` replace it with the local fake.
- `AI_GATEWAY_URL`: the AI Gateway REST base URL, `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1`. It is empty in the repository, because it names the Operator's account. Set it before a deploy. A Turn with an empty value fails and names the value. `dev` and `request` replace it with the local fake.
- `AI_GATEWAY_ID`: the gateway that the request names in `cf-aig-gateway-id`.
- `REPLY_MODEL`: the model for the reply task, in the `<provider>/<model>` form of AI Gateway.

The Model Gateway uses the AI Gateway REST endpoint, not the `/compat` endpoint, because Cloudflare marks `/compat` as deprecated for single-model chat completions. On this endpoint the token is a Cloudflare API token with the Workers AI Read permission, sent as `Authorization: Bearer`. Model Credentials use Unified Billing. Each request sends the Owner Id in `cf-aig-metadata` and `cf-aig-collect-log-payload: false`, so the gateway logs keep metadata and no prompt or reply text.

## Secrets

`wrangler.jsonc` lists the required Worker secrets in `secrets.required`. This list is the only source of secret names.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `AI_GATEWAY_TOKEN`: the Cloudflare API token for AI Gateway (Workers AI Read).
- `OPERATOR_TOKEN`: the bearer token of the Operator route.

For local dev, put them in `apps/agent/.dev.vars`. Git ignores this file. Never commit, log, or paste secret values. Deploying and setting secrets on Cloudflare need the repository owner's approval (decision 0002).

## Bundle size and startup

Measured on 2026-11-14 with `pnpm control bundle` (wrangler 4.162.0, Agents SDK 0.33.0, Effect 4.1.4, AI SDK 7.0.172). The Worker now includes the AI SDK, the OpenAI-compatible provider, and Effect Schema, so the full stack probe of the foundation slice is removed.

| Entry | Size (uncompressed) | gzip (not limited) | Local startup CPU |
| --- | --- | --- | --- |
| Worker (`src/index.ts`) | 3,842.92 KiB | 728.48 KiB | 313.7 ms |

Limits from the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/), read on 2026-11-13:

- Worker size: 64 MiB uncompressed, on the Free and the Paid plan. There is no compressed size limit. The 3 MB figure in the [feasibility study](../research/2026-11-12-cloudflare-feasibility.md) is out of date.
- Startup: the global scope must parse and run within 1 second.
- CPU time: 10 ms for each HTTP request on the Free plan. Waiting for network I/O does not count.

Result: the Worker uses 5.9% of the size limit. It fits the free plan for bundle size.

Startup CPU is measured on the local machine, which has a different CPU from Cloudflare. The numbers changed between runs on a shared machine, so `bundle` shows them but does not enforce them. The CPU time for each webhook request and each alarm Turn needs the deployed Worker and is measured in the live slice.
