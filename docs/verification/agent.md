# Verification guide: apps/agent

`apps/agent` is one Cloudflare Worker: the Edge, the Personal Agent Durable Object, and the Directory D1 binding. Terms follow [CONTEXT.md](../../CONTEXT.md).

## Message flow

1. Telegram sends an update to `POST /telegram/webhook`. The Edge checks the `X-Telegram-Bot-Api-Secret-Token` header and keeps only text messages from private chats.
2. The Edge finds the Owner for the Channel Identity `telegram:<user id>` through the Directory. It reads with a D1 session from the nearest replica. When the replica has no row, it reads the primary, so an Owner who was just added is not lost to replica lag.
3. The Edge gives the Event to the Owner's Personal Agent. The Personal Agent stores the Event in its Inbox, writes an `EventReceived` Journal Entry, and schedules a Turn with the Agents SDK `schedule`, which uses a durable alarm. Then the Edge answers 200.
4. The alarm runs one Turn. The Turn answers each pending Event separately, oldest first. For each Event, it reads the recent conversation and asks the Model Gateway for a reply. The Model Gateway runs the AI SDK `ToolLoopAgent` (built for each request, so per-step hooks, MCP tools, and `toolApproval` can join its settings) with the tools of the Turn and the step limit of the Behavior Config (`maxToolSteps`), and records Usage for every step. Only a model call is retried and has a timeout. A tool runs once, through the Effect runtime of the Personal Agent, and a tool failure reaches the model as an error result. When the loop ends on a tool call at the step limit, the Turn fails and sends the honest failure message. A failed Turn still keeps the tool calls and results of its finished steps in `Conversation`, so the next Turn knows what its tools did. `Conversation` stores AI SDK `ModelMessage` values (JSON, checked by a schema), including tool calls and tool results, and the recent window of 20 messages starts at an Owner message so that it never splits a tool call from its result. Burst merge is not in this slice.
5. The Turn writes `ReplyPlanned` and `SendStarted`, then sends the reply with Telegram `sendMessage`. A reply longer than 4,096 characters goes as several messages, cut at a line break or a space when possible, and the send is confirmed only when Telegram confirms every part. It writes `ReplySent` only with the Telegram message id. A refused or failed send writes `ReplyFailed` and then `TurnFailed` with the same reason, and the Events are failed.
6. When the model fails 3 times, the Turn writes `TurnFailed` with the reason, then sends one honest message through the same `ReplyPlanned`, `SendStarted`, and `ReplySent` or `ReplyFailed` steps, and fails the Event.
7. After the model call, and before `ReplyPlanned` or `TurnFailed`, the Turn writes one Trace. So a Journal with `ReplyPlanned` or `TurnFailed` for an Event always has a Trace for it. A Turn that runs again after a crash writes a new Trace, and the earlier one stays.
8. At the end of the Turn, and for each refused request at the Edge, the Worker writes one Analytics Engine data point.

## Traces and Operator metrics

A Trace is a row of `turn_traces` in the Personal Agent SQLite. The row has the Owner Id, the Event id, the result of the model call (`model_replied` or `model_failed`), and a JSON record with the task, the model id, the model settings (attempts and timeout of each attempt), the system prompt, the messages that the model received, the steps (the tool calls of each step with their call id, input, output, and failure flag, and the Usage of each step), the reply or the error, the summed Usage, and the model latency. The Trace redacts every step. A Turn that reaches the step limit has a `model_failed` Trace with its steps. Operator metrics carry the number of steps and tool calls and no content. Replay a Turn by giving the system prompt and the messages of its Trace to the Model Gateway. The table refuses updates and deletes with storage triggers, and the interface has only record and read. The Trace records the model call only. The send result of the same Event is in the Journal (`ReplySent` or `ReplyFailed`), found by the Event id, so a Turn whose send failed has a `model_replied` Trace and a `ReplyFailed` Journal Entry. The Trace has private content and never leaves the Personal Agent.

The Operator metrics go to the Analytics Engine dataset `assistant_operator_metrics` (binding `OPERATOR_METRICS`). Each data point has:

| Field | Value |
| --- | --- |
| `index1` | The Owner Id, or `none` when the request has no Owner |
| `blob1` | `turn` or `refused` |
| `blob2` | The result: `replied`, `model_failed`, or `send_failed` for a Turn; `bad_secret_token`, `unknown_sender`, or `owner_not_active` for a refused request |
| `blob3` | The model id for a Turn, empty for a refused request |
| `blob4` | `cost_known` or `cost_unknown` for a Turn, empty for a refused request |
| `double1` | Latency in milliseconds. For a Turn: from the start of the Turn for the Event to the end of the send. For a refused request: the time in the Edge. |
| `double2` to `double5` | Input tokens, output tokens, cost in USD, cached input tokens. The value is 0 when the provider gave none. |

The metric type allows only these fields, so message content cannot enter a data point. The cost is always 0 and `blob4` is `cost_unknown` now, because the AI SDK does not report the cost. Reading the cost from AI Gateway is a known gap. A data point is written after the send, so a Turn that stops between a confirmed send and the data point has none. The data points are best-effort; the Journal and the Trace are the record. A write that throws is logged as a warning without content and never stops the Edge response or the Turn.

Secrets: the Redactor replaces the values of `TELEGRAM_BOT_TOKEN`, `AI_GATEWAY_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `OPERATOR_TOKEN` in the model error, in the Telegram failure reason, in the reply, and in the system prompt and the messages of the Trace, before they enter a Trace or the Journal. The Inbox keeps the Owner message as sent.

AI Gateway keeps no prompt or reply text because each request sends `cf-aig-collect-log-payload: false`. A test checks the header. The gateway-level logging setting in the Cloudflare account is not checked here. Check it on the deployed account (it needs the repository owner's approval) and record the result in the PR.

The Operator adds the Owner with `POST /operator/owners`. This route needs `Authorization: Bearer <OPERATOR_TOKEN>` and writes through the Directory interface. It does not open Registration.

## Verify a change

Run `pnpm verify` at the repository root. Turborepo runs the `verify` script of each workspace that the branch changed (`turbo run verify --affected`). To run only this workspace, run `pnpm --filter @repo/agent verify`.

The workspace `verify` script runs these checks in this order:

| Command | What it proves |
| --- | --- |
| `pnpm typecheck` | `worker-configuration.d.ts` matches `wrangler.jsonc` (`wrangler types --check`). The Worker code, the tests, and the control CLI type-check. |
| `pnpm control map --check` | The [Feature Map](agent-feature-map.md) matches the Edge route table in `src/edge/routes.ts`. |
| `pnpm test` | The behavior tests pass (see below). |
| `pnpm control bundle` | The Worker builds with a dry run and is below the Workers size limit. |

After a change to a table schema, run `pnpm --filter @repo/agent migrations:generate` and commit the new migration files.

After a change to `wrangler.jsonc`, run `pnpm --filter @repo/agent types` and commit the new `worker-configuration.d.ts`.

The root lint rules let only `src/personal-agent` import the Agents SDK (decision 0003). Other modules use `personalAgentFor` and the `PersonalAgent` class.

## Behavior tests

Vitest runs two projects.

- `worker`: tests in `test/` run inside workerd with `@cloudflare/vitest-plugin`. They use real Durable Objects with SQLite storage and a real local D1 database. Each test file gets isolated storage.
- `control`: tests in `control/` run in Node and check the control CLI.

Local fixtures:

- Test Worker entry. `test/worker.ts` exports the real Edge and a `PersonalAgent` subclass. The subclass gives the Turn a fake model from the AI SDK test utilities (`MockLanguageModelV4`) and the real Telegram Channel with a fake Telegram API `fetch`. A fake Analytics Engine dataset replaces the `OPERATOR_METRICS` binding for the Edge and the Turn. The fakes are in `test/fakes.ts`, and they record each call. The real Model Gateway, Inbox, Journal, and Usage code runs.
- Directory migrations. `test/apply-migrations.ts` applies `src/directory/migrations/*/migration.sql` to the test D1 database before each test file.
- Personal Agent migrations. Each Personal Agent applies `src/personal-agent/migrations` when it builds its storage layer. Drizzle Kit generates both sets from the table schemas (decision 0007).
- No network. The test runtime answers every outbound `fetch` with status 503 and the text `Network is off in tests: <url>`. Remote bindings are off. A test proves this.
- Test secrets. `vitest.config.mts` sets fixed fake values for the required secrets. Tests never read `.dev.vars`.
- Loading the Agents SDK module graph is slow in the test runtime. The `worker` project pre-bundles `agents`, `effect`, `drizzle-orm`, and the Effect SQL clients with the Vitest dependency optimizer. Without the Drizzle and SQL entries, the module graph is too large for the test worker connection and the run fails with `Message is too large`. Tests import Worker modules at the top of the file, so the load happens while Vitest collects the file, not inside a test with a time limit. Call the Worker as `worker.fetch(request, env, createExecutionContext())`. Do not use `exports.default.fetch` in tests: its first call loads the module graph inside the test and can time out on a cold run.

What the tests prove now:

- The Operator route adds the Owner and the Channel Identity through the Directory, and Registration stays closed. A request without the Operator token gets 401 and stores nothing. A Channel Identity that already has an Owner gets 409.
- A webhook request with a missing or wrong secret token (also one of another length) gets 401. The Owner's Personal Agent has no Inbox Event and no Journal Entry, and the fake Telegram API gets no `sendMessage`.
- A text message from an unknown sender, or from an Owner who is suspended, gets 200 and no reply. The Directory gains no Owner and no Channel Identity, and the Owner's Personal Agent keeps no content.
- A sticker, an edited message, a group chat text, a text from a bot, and a body that is not an update (or not JSON) get 200 and are ignored. The Owner's Personal Agent keeps no Event and no Journal Entry, and no reply is sent. Only a wrong or missing secret token gets 401. Telegram always sends the correct token, so it does not retry; the refusal reaches only other callers.
- A text message from the Owner is in the Inbox when the webhook answers 200, while the fake model still holds the Turn. The alarm then runs the Turn, and the fake Telegram API gets exactly one `sendMessage`: plain text, to the Owner's chat, as a reply to the Owner's message.
- The prompt has the static system part first, then the conversation, then the new message.
- Each Turn with a successful model call and a confirmed send writes `EventReceived`, `ReplyPlanned`, `SendStarted`, and `ReplySent` Journal Entries for the Owner, and one Usage row with input, output, and cached tokens. A Turn whose model failed 3 times writes no Usage row.
- A model that fails 3 times gives a `TurnFailed` entry with the reason and exactly one honest `sendMessage`. A Turn that stopped after `TurnFailed` sends the honest message once, does not call the model again, and keeps the Event failed, also when the honest message was already confirmed. When the honest message started to send without a confirmation, the Turn writes `ReplyFailed` and does not send again. An honest message that Telegram refuses is recorded as `ReplyFailed`, never as sent, and is not sent again.
- A send that Telegram refuses writes `ReplyFailed` and never `ReplySent`.
- An update that Telegram sends again (same `update_id`), also after the Turn finished, gets 200 and no second Event and no second `sendMessage`.
- An Event whose Turn stopped before the reply was planned gets one reply when the Turn runs again. An Event with a confirmed send in the Journal gets no second `sendMessage` and is marked done, unless the Journal has `TurnFailed`; then the Event stays failed.
- A `ReplyPlanned` entry without `SendStarted` means that no message left yet, so the Turn plans and sends again. When a send started (`SendStarted`) but the Journal has no confirmation, the Turn does not send again. It writes `ReplyFailed` with the reason that the send was not confirmed and marks the Event failed. A test with a Telegram answer that is lost in transit shows one `sendMessage` and no second one. Reason: Telegram cannot tell the agent whether a message arrived, so the rule never sends a second time and accepts that the Owner may get no reply. The Owner can send the message again.
- A webhook for an update that is already stored schedules a Turn while any Event is pending, so a crash between storing and scheduling heals when Telegram sends the update again. The recovery tests start the Turn from the Agents SDK alarm (`schedule`), not by a direct call. One test resets the Durable Object while the fake model holds a Turn, runs the saved alarm again, and finds one `sendMessage`.
- A reply longer than the Telegram limit of 4,096 characters is split into parts within the limit, without a cut inside an emoji. It is confirmed only when every part is confirmed, and a failed part fails the delivery.
- A Personal Agent on an older schema keeps its rows when a later migration changes a table, and applies each migration once. A migration that fails leaves no partial schema and fails the storage layer with `MigrationFailed`.
- The Journal storage refuses updates and deletes, and entries stay the same after a later Turn.
- The Model Gateway calls `<AI Gateway URL>/chat/completions` with `cf-aig-gateway-id`, the Owner Id in `cf-aig-metadata`, and `cf-aig-collect-log-payload: false`.
- Each Turn writes one Trace with the exact prompt that the model received (a test compares it with the call that the fake model recorded), the model settings, the reply, and Usage. A Turn whose model failed 3 times writes a `model_failed` Trace with the error. A secret in the model error, in the Owner message, or in the reply is replaced and appears in no Trace, no Journal Entry, and no Usage row. The Trace storage refuses updates and deletes.
- Each Turn writes one Analytics Engine data point with the Owner Id, the result, latency, tokens, and cache hits. A refused request (missing or wrong secret token, unknown sender, or an Owner who is not active) writes one data point with the reason. A non-text update writes none. No data point holds message text. A throwing dataset changes no Edge status and does not stop the Turn.
- Capture a Note (`test/capture-a-note.test.ts`): a text creates one Note with the source (Event, Channel message) and trust level `owner`, set by code from the Event. A link, with or without a comment, creates a Note with the URL, and the agent has no tool that opens a link. A `capture_note` call followed by two failed model calls and then a success creates one Note and one reply. A Durable Object reset after the Note write and before the reply creates one Note, one `NoteCaptured` Journal Entry, and one reply. A repeated write of the same normalized text for one Event returns the existing Note. `capture_note` saves its tool call and result in `turn_progress` in the same transaction as the Note and its Journal Entry, so a Turn that restarts after a reset replays them to the model and the step limit counts them. The conversation keeps them once for each Event (one transaction, `conversation_recorded_events`), also when the restarted Turn fails and also when the Durable Object resets after the reply was sent and before the conversation write; Journal recovery finishes that write. The step limit counts model steps, not tool calls (the saved rows carry a key for the model step). When the saved model steps already use up the step limit, the restarted Turn sends the honest failure message and does not call the model. A failed save of the tool step leaves no Note. A failed write, also a failed Journal append, leaves no Note and no Journal Entry, and the model sees the tool error. The system prompt says to claim a kept Note only after the tool succeeded. The tests cannot prove what a real model says after a failed write.
- With two Owners, each Personal Agent holds only its own Inbox Events, Journal Entries, Traces, and Usage rows. No row of one Owner has the other Owner's Owner Id or text.
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
| `request --contains <text> [--message <text>]` | Starts the real Worker with temporary storage, random secrets, a fake Telegram API, and a fake model. Adds an Owner, sends a sample Telegram text message to the webhook, and waits for the fake `sendMessage`. It exits with 1 when the reply does not contain the text. The fake model answers `You said: <message>`. When the message starts with `keep: `, the fake model calls `capture_note` with the rest of the text, and then answers `Kept note <Note id>: <text>` from the tool result. | None |
| `map [--check]` | Writes the [Feature Map](agent-feature-map.md) from the Edge route table in `src/edge/routes.ts`. With `--check`, it exits with 1 when the map is out of date. Run `map` after a route change. | None |
| `bundle` | Builds the Worker with `wrangler deploy --dry-run`, then profiles startup with `wrangler check startup`. It exits with 1 when the bundle is over the size limit. | None |

`doctor` checks local secrets the same way as `wrangler dev`: from `.dev.vars`, or else from `.env` files and the shell environment. It does not check the secrets of a deployed Instance.

Example local proof:

```sh
pnpm control request --contains "You said: Hello agent"
pnpm control request --message "keep: buy a gift for Ana before Friday" --contains "Kept note"
```

The second command proves a Capture: the reply names a Note id that `capture_note` returned.

`owner add` with `--url` set to a deployed Instance changes production data. It needs the repository owner's approval (decision 0002). `webhook set` comes with the live slice.

## Configuration

`wrangler.jsonc` `vars`:

- `TELEGRAM_API_URL`: the Telegram Bot API origin. `dev` and `request` replace it with the local fake.
- `AI_GATEWAY_URL`: the AI Gateway REST base URL, `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1`. It is empty in the repository, because it names the Operator's account. Set it before a deploy. A Turn with an empty value fails and names the value. `dev` and `request` replace it with the local fake.
- `AI_GATEWAY_ID`: the gateway that the request names in `cf-aig-gateway-id`.
- `REPLY_MODEL`: the model for the reply task, in the `<provider>/<model>` form of AI Gateway.
- `REPLY_REASONING_EFFORT`: `none`, `low`, `medium`, or `high`. Each Model Task has its own model and thinking level, which form its route. The reply task sends this value as `reasoning_effort`. `none` turns thinking off on DeepSeek V4.1 Flash and cut the output tokens of a short reply from 76 to 8 in a live test. Use `none` for short chat replies. Use `low` or higher for the tasks that plan, call tools, or recall, when those tasks exist, and set the level from Eval results.
- `MODEL_BILLING`: the billing mode of the Model Credentials, `unified-billing` (default) or `byok`. With `byok`, each request sends `cf-aig-no-wholesale: true`, so AI Gateway uses the Operator's stored provider key and does not fall back to Unified Billing. The setup of the stored key comes with `create-assistant`.

The Model Gateway uses the AI Gateway REST endpoint, not the `/compat` endpoint, because Cloudflare marks `/compat` as deprecated for single-model chat completions. On this endpoint the token is a Cloudflare API token with the Workers AI Read permission, sent as `Authorization: Bearer`. Model Credentials are the token and the billing mode. Each request sends the Owner Id in `cf-aig-metadata` and `cf-aig-collect-log-payload: false`, so the gateway logs keep metadata and no prompt or reply text.

## Secrets

`wrangler.jsonc` lists the required Worker secrets in `secrets.required`. This list is the only source of secret names.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `AI_GATEWAY_TOKEN`: the Cloudflare API token for AI Gateway (Workers AI Read).
- `OPERATOR_TOKEN`: the bearer token of the Operator route.

For local dev, put them in `apps/agent/.dev.vars`. Git ignores this file. Never commit, log, or paste secret values. Deploying and setting secrets on Cloudflare need the repository owner's approval (decision 0002).

## Bundle size and startup

Measured on 2026-11-14 with `pnpm control bundle` (wrangler 4.162.0, Agents SDK 0.33.0, Effect 4.1.4, AI SDK 7.0.172, Drizzle ORM 1.0.0-rc.5). The Worker now includes the AI SDK, the OpenAI-compatible provider, and Effect Schema, so the full stack probe of the foundation slice is removed.

| Entry | Size (uncompressed) | gzip (not limited) | Local startup CPU |
| --- | --- | --- | --- |
| Worker (`src/index.ts`) | 4,215.65 KiB | 801.60 KiB | 319.7 ms |

Limits from the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/), read on 2026-11-13:

- Worker size: 64 MiB uncompressed, on the Free and the Paid plan. There is no compressed size limit. The 3 MB figure in the [feasibility study](../research/2026-11-12-cloudflare-feasibility.md) is out of date.
- Startup: the global scope must parse and run within 1 second.
- CPU time: 10 ms for each HTTP request on the Free plan. Waiting for network I/O does not count.

Result: the Worker uses 6.4% of the size limit. It fits the free plan for bundle size. Workers Paid is the supported plan ([decision 0008](../decisions/0008-workers-paid-plan.md)), so the free-plan CPU limit is not a release gate.

Startup CPU is measured on the local machine, which has a different CPU from Cloudflare. The numbers changed between runs on a shared machine, so `bundle` shows them but does not enforce them. The CPU time for each webhook request and each alarm Turn needs the deployed Worker and is measured in the live slice.
