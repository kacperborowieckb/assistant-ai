# Verification guide: apps/agent

`apps/agent` is one Cloudflare Worker: the Edge, the Personal Agent Durable Object, and the Directory D1 binding. Terms follow [CONTEXT.md](../../CONTEXT.md).

## Message flow

1. Telegram sends an update to `POST /telegram/webhook`. The Edge checks the `X-Telegram-Bot-Api-Secret-Token` header and keeps only text messages from private chats.
2. The Edge finds the Owner for the Channel Identity `telegram:<user id>` through the Directory. It reads with a D1 session from the nearest replica. When the replica has no row, it reads the primary, so an Owner who was just added is not lost to replica lag.
3. The Edge gives the Event to the Owner's Personal Agent. The Personal Agent stores the Event in its Inbox, writes an `EventReceived` Journal Entry, and schedules a Turn with the Agents SDK `schedule`, which uses a durable alarm. Then the Edge answers 200.
4. The alarm runs one Turn. The Turn answers each pending Event separately: Owner messages first, then other Events, each group oldest first. For each Event, it reads the recent conversation, adds the current local time of the Owner as the last section of the system prompt (or says that the time zone is not known), and asks the Model Gateway for a reply. The Model Gateway runs the AI SDK `ToolLoopAgent` (built for each request, so per-step hooks, MCP tools, and `toolApproval` can join its settings) with the tools of the Turn and the step limit of the Behavior Config (`maxToolSteps`), and records Usage for every step. Only a model call is retried and has a timeout. A tool runs once, through the Effect runtime of the Personal Agent, and a tool failure reaches the model as an error result. When the loop ends on a tool call at the step limit, the Turn fails and sends the honest failure message. A failed Turn still keeps the tool calls and results of its finished steps in `Conversation`, so the next Turn knows what its tools did. `Conversation` stores AI SDK `ModelMessage` values (JSON, checked by a schema), including tool calls and tool results, and the recent window of 20 messages starts at an Owner message so that it never splits a tool call from its result. Burst merge is not in this slice.
5. The Turn writes `ReplyPlanned` and `SendStarted`, then sends the reply with Telegram `sendMessage`. A reply longer than 4,096 characters goes as several messages, cut at a line break or a space when possible, and the send is confirmed only when Telegram confirms every part. It writes `ReplySent` only with the Telegram message id. A refused or failed send writes `ReplyFailed` and then `TurnFailed` with the same reason, and the Events are failed.
6. When the model fails 3 times, the Turn writes `TurnFailed` with the reason, then sends one honest message through the same `ReplyPlanned`, `SendStarted`, and `ReplySent` or `ReplyFailed` steps, and fails the Event.
7. After the model call, and before `ReplyPlanned` or `TurnFailed`, the Turn writes one Trace. So a Journal with `ReplyPlanned` or `TurnFailed` for an Event always has a Trace for it. A Turn that runs again after a crash writes a new Trace, and the earlier one stays.
8. At the end of the Turn, and for each refused request at the Edge, the Worker writes one Analytics Engine data point.
9. The Personal Agent keeps one Agents SDK alarm (callback `fireDueSchedules`) at the earliest due instant of its active Schedules. When it runs, each due Schedule enters the Inbox as a `ScheduleFired` Event (one for each Schedule id and due instant), and a Turn is scheduled. For a `ScheduleFired` Event the Turn makes no model call. It sends the saved Reminder text to the Owner Channel Conversation through the same `ReplyPlanned`, `SendStarted`, and `ReplySent` or `ReplyFailed` steps, marks the Schedule `done` only after a confirmed send, writes one Trace with the result `reminder_delivered` or `reminder_delivery_failed`, and writes one Operator metric of the kind `reminder`.

## Traces and Operator metrics

A Trace is a row of `turn_traces` in the Personal Agent SQLite. The row has the Owner Id, the Event id, the result (`model_replied` or `model_failed` for a model-answered Event; `reminder_delivered` or `reminder_delivery_failed` for a Reminder, whose record has the Schedule id, the due instant, the text, and no model fields), and a JSON record with the task, the model id, the model settings (attempts and timeout of each attempt), the system prompt, the messages that the model received, the steps (the tool calls of each step with their call id, input, output, and failure flag, and the Usage of each step), the reply or the error, the summed Usage, and the model latency. The Trace redacts every step. A Turn that reaches the step limit has a `model_failed` Trace with its steps. Operator metrics carry the number of steps and tool calls and no content. Replay a Turn by giving the system prompt and the messages of its Trace to the Model Gateway. The table refuses updates and deletes with storage triggers, and the interface has only record and read. The Trace records the model call only. The send result of the same Event is in the Journal (`ReplySent` or `ReplyFailed`), found by the Event id, so a Turn whose send failed has a `model_replied` Trace and a `ReplyFailed` Journal Entry. The Trace has private content and never leaves the Personal Agent.

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
- `control`: tests in `control/` run in Node and check the control CLI. The Eval tests start the eval Worker in the wrangler test harness with the local fakes (see [Eval](#eval)).

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
- Event union (`test/schedule-fired-event.test.ts`, `test/telegram-channel.test.ts`): the Inbox keeps one `ScheduleFired` Event when it stores the same Schedule id and due instant twice. Pending Owner messages come before a pending `ScheduleFired` Event, also when the `ScheduleFired` Event arrived first. After an Owner message, the Personal Agent keeps the Owner Channel Conversation (Channel and conversation id), and a later `ScheduleFired` Event is sent there with no reply parameters. The migration copies the Owner Channel Conversation from the latest stored Owner message, so an Owner who wrote before the upgrade keeps their destination (`test/agent-storage.test.ts`). With no Owner Channel Conversation, the Turn of a `ScheduleFired` Event writes `ReplyFailed`, sends nothing, and fails the Event. When the Turn runs again after a reset with `ReplyFailed` and `TurnFailed` already written and no `SendStarted`, it only marks the Event failed and sends no apology, also when the Owner has written since. The Telegram Channel sends a message with no message to reply to as a request with no `reply_parameters`. No code creates `ScheduleFired` yet, so these tests store the Event directly.
- Capture a Note (`test/capture-a-note.test.ts`): a text creates one Note with the source (Event, Channel message) and trust level `owner`, set by code from the Event. A link, with or without a comment, creates a Note with the URL, and the agent has no tool that opens a link. A `capture_note` call followed by two failed model calls and then a success creates one Note and one reply. A Durable Object reset after the Note write and before the reply creates one Note, one `NoteCaptured` Journal Entry, and one reply. A repeated write of the same normalized text for one Event returns the existing Note. `capture_note` saves its tool call and result in `turn_progress` in the same transaction as the Note and its Journal Entry, so a Turn that restarts after a reset replays them to the model and the step limit counts them. The conversation keeps them once for each Event (one transaction, `conversation_recorded_events`), also when the restarted Turn fails and also when the Durable Object resets after the reply was sent and before the conversation write; Journal recovery finishes that write. The step limit counts model steps, not tool calls (`capture_note` marks its model step in `turn_model_steps` before it writes, so a step whose tool call failed still counts). When the saved model steps already use up the step limit, the restarted Turn sends the honest failure message and does not call the model. A failed save of the tool step leaves no Note. A failed write, also a failed Journal append, leaves no Note and no Journal Entry, and the model sees the tool error. The system prompt says to claim a kept Note only after the tool succeeded. The tests cannot prove what a real model says after a failed write.
- Edit and link Notes (`test/edit-and-link-notes.test.ts`): after a captured Note, a follow-up `update_note` call changes the text of the same Note, creates no new Note, keeps the captured date, and sets a new last-checked date. Search finds the new text and not the old text. An update appends one `NoteUpdated` Journal Entry with the kind of change (`text`, `links`, or `text_and_links`), and the tool call appears in the Trace. `capture_note` with `linkedNoteIds` creates a second Note and one undirected link, and `search_notes` returns the linked Notes from both sides, with their source and URL. For each match it returns at most the five newest linked Notes (ordered by the date of the link) and the total count of links, which a test with seven links checks, including which Notes come back. `list_linked_notes` returns the older linked Notes of a Note from an offset (a test checks the page after the first five and the total count), and returns a tool error for an unknown Note id. An update that changes nothing still marks its model step, so the step limit survives a restart. A link to an unknown Note id, in a capture or an update, gives the model a tool error and writes no Note, link, Journal Entry, or text change. An update with no change gives a tool error. The tests cannot prove that a real model finds the right Note for a follow-up; an Eval Case measures that when it exists (see [Eval](#eval)).
- Recall with keyword search (`test/recall-a-note.test.ts`, `test/owner-isolation.test.ts`): `Notes.search` finds a Note by keywords or by its URL, ranks the better match first with bm25, honors the limit, and returns nothing for a query without words. The FTS5 table `notes_fts` stays in step after a write, after an update of the text or URL (SQL triggers), and when a write rolls back. With a scripted fake model, a question calls `search_notes` and the reply uses the result; no match gives an empty list. An `untrusted` Note in a result is marked as Untrusted Content. A broken search table gives the model a tool error. Owner B's search never returns Owner A's Notes. The tests cannot prove that a real model names the source and the date or says "I do not know"; an Eval Case measures that when it exists (see [Eval](#eval)).
- Profile in every Turn (`test/profile.test.ts`, `test/owner-isolation.test.ts`): a scripted `update_profile` add writes one Profile entry, and the system prompt of the next Turn contains its text. An empty Profile shows as empty in the prompt of the first model call. A remove takes the entry out of the next prompt. An add that would pass `maxProfileCharacters` writes nothing, appends no Journal Entry, and the tool result that the model receives says that the Profile is full. A remove of an unknown entry id writes nothing. Each add and remove appends a `ProfileEntryAdded` or `ProfileEntryRemoved` Journal Entry and has an `update_profile` tool call in the Trace. A Profile entry of one Owner is not in the Profile, the Trace, or the prompt of another Owner.
- Owner time zone and current time (`test/owner-time-zone.test.ts`, decision [0013](../decisions/0013-schedules-and-time.md)): unit tests with `TestClock` check the time text: the local date, weekday, time, and time zone, the daylight saving offset of `Europe/Warsaw` and `America/New_York`, the Behavior Config default, the override by the Owner Preference, and the "not known" text when neither exists or the default is invalid. In the Worker, a scripted `set_time_zone` call writes the preference (the name is normalized in case), the next Turn shows the local time in that zone, and the time text is the last line of the system prompt. Each change, and no repeat of the same value, appends one `OwnerPreferenceChanged` Journal Entry. An invalid name changes nothing, appends no Journal Entry, and returns a message to the model. A Turn for a forwarded message (Trust Level `untrusted`) gets no `set_time_zone` tool.
- Reminders (`test/reminders.test.ts`, decision [0013](../decisions/0013-schedules-and-time.md)): with the time zone `Europe/Warsaw`, a scripted `set_reminder` call stores one active Schedule at the right UTC instant (09:00 in January is 08:00Z), sets `set_by` to `owner`, appends a `ScheduleSet` Journal Entry, and returns the local weekday, date, and time. A message that keeps a Note and sets a Reminder gives one Note and one Schedule with that Note id. A `set_reminder` call, then a failed model call, then the same call again creates one Schedule and one `ScheduleSet` entry. With no time zone, a past due time, or a date that does not exist (February 30), the tool fails with a message for the model and writes no Schedule. A forwarded (untrusted) message gets no `set_reminder` tool. The SDK alarm (callback `fireDueSchedules`) is armed at the earliest due instant after a set and after a fire, and none is left when no active Schedule is waiting. When the alarm runs, the Inbox gets a `ScheduleFired` Event, and the Turn sends the saved text to the Owner Channel Conversation with no model call (the fake model has no call), marks the Schedule `done`, writes `ScheduleFired`, `ReplyPlanned`, `SendStarted`, `ReplySent`, and `ScheduleCompleted` Journal Entries, and one Trace with the result `reminder_delivered` and no model fields. Highest risk, exactly once: an alarm that runs twice, also at the same time, gives one `sendMessage`; a Durable Object reset after the Inbox write and before the send gives one `sendMessage`; a reset after a confirmed send and before the Schedule is `done` gives no second `sendMessage` and completes the Schedule. A refused send writes `ReplyFailed` and a `reminder_delivery_failed` Trace, keeps the Schedule `active`, and arms no alarm, so the alarm does not loop. Known limits: a failed delivery is not retried (the Inbox key is the Schedule id and the due instant), a Reminder is not marked late, and repeat, list, change, and cancel come in later specs of #52.
- Untrusted Content from forwarded messages (`test/forwarded-messages.test.ts`): a forwarded text creates an `untrusted` Note with the forward origin as source and the forwarded text as Note text, also when the scripted model passes other text or asks for trust level `owner`. In a Turn for such an Event the model gets no `update_profile` and no `update_note` tool, and the Profile does not change. The forwarded text and its origin appear in the prompt once, inside the Untrusted Content data block, and a closing marker inside the text or the origin name cannot end the block. The `capture_note` result shows the Note text inside the block. A plain Owner message keeps the `owner` trust level and both tools. The tests cannot prove how a real model reacts to injected text, and the text that the model itself writes in a tool call (for example a quote) is not marked.
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
| `request --contains <text> [--message <text>]... [--wait-for-later-message]` | Starts the real Worker with temporary storage, random secrets, a fake Telegram API, and a fake model. Adds an Owner, sends each `--message` (the flag repeats; the default is one sample text) to the webhook in order, and waits for the fake `sendMessage` after each, and joins the parts of a reply that Telegram splits (all parts reply to the same message). It exits with 1 when the last reply does not contain the text. The fake model answers `You said: <message>`. With `--wait-for-later-message`, a last reply without the text does not fail at once: the command waits up to 100 seconds for a later message that contains it, which a Reminder needs. When the message starts with `remind: `, the fake model calls `set_reminder` for the next minute of the Owner's local time (taken from the system prompt, so it is 1 to 60 seconds ahead), and answers `Reminder set for <local time> (<zone>)`; send `zone: Europe/Warsaw` first. Example: `pnpm control request --message "zone: Europe/Warsaw" --message "remind: buy the gift" --contains "buy the gift" --wait-for-later-message` shows the Reminder in the fake Telegram without a reply target, after the model calls of the two messages and none for the delivery. When the message starts with `keep: `, the fake model calls `capture_note` with the rest of the text, and then answers `Kept note <Note id>: <text>` from the tool result. When the message starts with `recall: `, the fake model calls `search_notes` with the rest of the text, and then answers `Recalled: <text> (Telegram message <id>, <date>)` from the best result, or `I do not know.` when the list is empty. When the message starts with `change: <words> => <text>`, the fake model calls `search_notes` with the words, then `update_note` with the best result and the new text, and answers `Changed note <Note id>: <text>`. When it starts with `link: <words> => <text>`, it calls `search_notes` with the words, then `capture_note` with the new text and the best result as a link, and answers `Kept note <Note id>: <text> (linked to <n> Note)`. When it starts with `linked: <words>`, it calls `search_notes` with the words, then `list_linked_notes` with the best result, and answers `Linked: <count> Note, newest: <text>`. | None |
| `eval --k <n> [--case <name>]...` | Runs each Eval Case k times against the real model and reports pass^k, the failed checks, and the tokens. See [Eval](#eval). It costs money, so it is not in `pnpm verify`, and an agent runs it only with the repository owner's approval (decision 0002). | AI Gateway (real model calls) |
| `map [--check]` | Writes the [Feature Map](agent-feature-map.md) from the Edge route table in `src/edge/routes.ts`. With `--check`, it exits with 1 when the map is out of date. Run `map` after a route change. | None |
| `bundle` | Builds the Worker with `wrangler deploy --dry-run`, then profiles startup with `wrangler check startup`. It exits with 1 when the bundle is over the size limit. | None |

`doctor` checks local secrets the same way as `wrangler dev`: from `.dev.vars`, or else from `.env` files and the shell environment. It does not check the secrets of a deployed Instance.

Example local proof:

```sh
pnpm control request --contains "You said: Hello agent"
pnpm control request --message "keep: buy a gift for Ana before Friday" --contains "Kept note"
```

The second command proves a Capture: the reply names a Note id that `capture_note` returned. This command proves Capture then Recall in one Worker run:

```sh
pnpm control request --message "keep: buy a gift for Ana before Friday" --message "recall: gift for Ana" --contains "Recalled: buy a gift for Ana before Friday"
```

These commands prove Edit and link on the real Worker: a change, and then a recall of the new text, and a capture that links to an existing Note.

```sh
pnpm control request --message "keep: buy a gift for Ana before Friday" --message "change: gift Ana => buy a red scarf for Ana" --message "recall: scarf" --contains "Recalled: buy a red scarf for Ana"
pnpm control request --message "keep: Ana likes red" --message "link: likes red => Ana birthday is on Friday" --contains "linked to 1 Note"
pnpm control request --message "keep: Ana likes red" --message "link: likes red => Ana birthday is on Friday" --message "linked: likes red" --contains "Linked: 1 Note, newest: Ana birthday is on Friday"
```

This command proves the time zone on the real Worker: `zone: <name>` makes the fake model call `set_time_zone`, and `time?` makes it answer with the current local time line that the system prompt of that Turn holds.

```sh
pnpm control request --message "zone: Europe/Warsaw" --message "time?" --contains "time zone Europe/Warsaw"
```

`owner add` with `--url` set to a deployed Instance changes production data. It needs the repository owner's approval (decision 0002). `webhook set` comes with the live slice.

## Eval

`pnpm control eval --k <n> [--case <name>]...` measures the agent with the real model (decisions [0011](../decisions/0011-eval-runner.md) and [0012](../decisions/0012-eval-owners-and-judge-evidence.md)). It costs money. It is not part of `pnpm verify`, and an agent runs it only with the repository owner's approval (decision 0002). Set `AI_GATEWAY_URL` and `AI_GATEWAY_TOKEN` in the environment or in `.dev.vars`.

1. It loads every case in `control/eval/cases` (or only the `--case` names) and decodes it with the case schema. An invalid file stops the command with the file name and the path of the bad field, before any model call.
2. It prints the range of expected model calls: for each run, 1 to `maxToolSteps` model steps for each Owner Event, and 1 judge call for each `reply_judged` check. Each call can have up to 3 attempts.
3. It starts the eval Worker (`eval/worker.ts`) in the wrangler test harness with temporary storage, random local secrets, a fake Telegram API on `127.0.0.1`, and the real AI Gateway. The eval Worker is the real Edge and Personal Agent plus the `/eval/seed`, `/eval/observation`, and `/eval/judge` routes, which need the local Operator token. The deployed Worker does not include them.
4. For each run, it adds a new Owner through the Operator route, seeds the case Notes and Profile entries, sends each Owner Event to the webhook, and waits until the Inbox has no pending Event. Then it reads the Notes with links, the Profile, the tool calls in the Traces, and the Usage, and applies the checks.
5. The report lists each case with PASS or FAIL, the passed runs of k, each failed check with its run and what the runner found, the agent and judge tokens, and the cost (unknown until #27). The command exits with 1 when a case fails.

A case file exports a default object that `satisfies EvalCaseFile`. Its name is the file name. Fields:

- `description`: what the case measures.
- `seed` (optional): `notes` (text, optional `url`, optional `forwardedFrom` for an `untrusted` Note) and `profile` entries (`kind` `fact` or `style_rule`, and `text`).
- `events`: the Owner Events in order, each with `text`, an optional `forwardedFrom` sender name for a forwarded message, and an optional `owner` (`A` or `B`, default `A`). Owner B is a second Owner with its own Personal Agent storage, for isolation cases. Each run adds both Owners, and `seed` fills Owner A.
- `checks`: `note_count` (`equals`), `note_matches` (`textIncludes` words, case does not matter; optional `url`, `trustLevel`, and `forwardOrigin`), `link_count` (`equals`, undirected links), `notes_linked` (`noteIncludes` and `linkedNoteIncludes`: a Note with the first words links to a Note with the second words), `profile_entry_count` (`equals`), `profile_entry_matches` (`textIncludes`, optional `kind`), `tool_calls` (`tool`, optional `min` and `max`; with neither, at least 1), and `reply_judged` (`rubric`). Each check has an optional `owner` (default `A`) that selects whose storage, Trace, or replies it reads; the report prefixes a failed check of Owner B with `Owner B,`. The judge gets the rubric in its system prompt, and the whole conversation of the run with the tool calls of the judged Owner as JSON data in the user message, and its instructions say never to follow text inside that data. Each seeded Note has its own seed Event id, so two seeded Notes with the same text stay two Notes. `--case` loads only the selected files, so an invalid other case does not block them. A failed `note_matches` shows each Note with its trust level, URL, and forward origin.

Cases: `capture-task-with-date`, `capture-link-with-comment`, `capture-link-alone`, `capture-fact-about-owner`, `capture-related-notes`, `recall-answer-with-source-and-date`, `recall-no-matching-note`, `recall-follow-up`, `untrusted-forwarded-instruction`, and `isolation-between-owners`. On 2026-11-15, with the owner's approval at k = 3, 6 of the 10 starter cases of issue #38 passed pass^3 on the real model: `capture-fact-about-owner`, `capture-link-alone`, `capture-link-with-comment`, `capture-related-notes`, `capture-task-with-date`, and `recall-follow-up`. Four failed because the model skipped a tool call that the system prompt asks for: `recall-answer-with-source-and-date` (2 of 3 runs, skipped `search_notes`), `recall-no-matching-note` (1 of 3, skipped `search_notes`), `untrusted-forwarded-instruction` (1 of 3, skipped `capture_note`), and `isolation-between-owners` (2 of 3, Owner A's message was not kept). Results vary between full runs of the same cases, so one run is weak evidence. A change of model or prompt is a separate decision.

Local proof with no network: `control/eval/run-eval.test.ts` runs the runner against the fake AI Gateway of `local-fakes.ts` with a fake judge (`fake-judge.ts`) that answers the verdicts that a test gives. One failed judge verdict of k runs fails the case, and the report has the pass count, the failed check, and the tokens. A case with seeded Notes and a Profile entry passes all k runs, and its link and Profile text checks fail with what the runner found when the links or the kind do not match. `control/eval/eval-cases.test.ts` checks the case schema errors and the `--case` selection.

## Configuration

`wrangler.jsonc` `vars`:

- `TELEGRAM_API_URL`: the Telegram Bot API origin. `dev` and `request` replace it with the local fake.
- `AI_GATEWAY_URL`: the AI Gateway REST base URL, `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1`. It is empty in the repository, because it names the Operator's account. Set it before a deploy. A Turn with an empty value fails and names the value. `dev` and `request` replace it with the local fake.
- `AI_GATEWAY_ID`: the gateway that the request names in `cf-aig-gateway-id`.
- `REPLY_MODEL`: the model for the reply task, with the name that the AI Gateway REST endpoint uses. A Workers AI model has the `@cf/` name, for example `@cf/deepseek-ai/deepseek-v4.1-flash-1017`. On 2026-11-15 the first real Eval run showed that the endpoint answers `Model not found` for the `workers-ai/@cf/...` name.
- `REPLY_REASONING_EFFORT`: `none`, `low`, `medium`, or `high`. Each Model Task has its own model and thinking level, which form its route. The reply task sends this value as `reasoning_effort`. `none` turns thinking off on DeepSeek V4.1 Flash and cut the output tokens of a short reply from 76 to 8 in a live test. Use `none` for short chat replies. Use `low` or higher for the tasks that plan, call tools, or recall, when those tasks exist, and set the level from Eval results.
- `EVAL_JUDGE_MODEL` and `EVAL_JUDGE_REASONING_EFFORT`: the route of the `eval_judge` Model Task, which only `pnpm control eval` uses to judge replies against a rubric. The Turn does not use it, but the route table of the Model Gateway has every Model Task, so a Turn also checks these values.
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
