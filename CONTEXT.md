# Context: ubiquitous language

Use these terms with these meanings in code, docs, issues, and prompts. Use the term, not a synonym. If you need a new term, add it here in the same change.

## People

- **Owner**: the person the agent serves. Each Owner has one Personal Agent and one set of data. Every domain operation runs for exactly one Owner.
- **Operator**: the person who deploys and runs an instance. When you self-host, you are the Operator and the only Owner. In the hosted product, the Operator runs the platform and the customers are the Owners.
- **Owner Id** (`OwnerId`): the stable identifier of an Owner. Storage, traces, usage, and jobs are keyed by it.

## Runtime

- **Instance**: one deployment of `apps/agent` on one Cloudflare account. An Instance has one or more Owners.
- **Edge**: the Worker entry point. It receives Channel traffic, finds the Owner through the Directory, and forwards the Event to that Owner's Personal Agent. It stores no Owner data.
- **Directory**: the store that maps Channel Identities to Owner Ids and records each Owner's status. It also says if Registration is open.
- **Registration**: the way a new Owner is added. A self-host Instance has closed Registration; setup adds the one Owner. The hosted product opens it through `apps/platform`.
- **Personal Agent** (`PersonalAgent`): the Durable Object for one Owner. It holds the Owner's memory, Journal, Inbox, Schedules, and preferences. It sleeps when idle and wakes on any Event.
- **Turn**: one run of the agent loop, from the Events it takes in to the messages and Journal Entries it produces.
- **Helper**: a durable workflow that does long or expensive work outside the chat Turn and returns only its result. Not in the MVP.

## Primitives

- **Channel**: an adapter between the agent and the Owner (for example Telegram). It receives messages and turns them into Events. It shows the agent's one send action in its own way.
- **Channel Identity**: the Owner's identity inside a Channel, for example a Telegram user id. The Directory maps it to an Owner Id.
- **Event**: a signal that wakes the agent: an Owner message, a fired Schedule, a finished Helper, or a webhook. Every Event enters the Inbox.
- **Inbox**: the queue of Events for one Owner. The router drops duplicates, merges bursts into one Turn, and puts Owner messages first.
- **Schedule**: a wake-up time. The Owner sets it (a Reminder) or the agent sets it for itself (proactive work).
- **Reminder**: a Schedule that the Owner asks for, with the text to send at that time.
- **Document**: something the agent writes, for itself or for the Owner. A Note is the main kind.
- **Note**: a small, linked unit of memory with metadata: source, trust level, and the date it was last checked.
- **Profile**: the short core facts and style rules about the Owner. The agent adds them to every Turn, and compaction never drops them.
- **Skill**: repeated work saved for reuse, with the tools it names. Loaded only when needed. Not in the MVP.
- **Journal**: the append-only log of every action and its result for one Owner. The agent reads it and cannot edit it.
- **Journal Entry**: one record in the Journal.
- **Tombstone**: the Journal Entry that a Forget leaves: what was deleted and when, without the content.

## Behavior

- **Capture**: the Owner sends something to keep (a note, task, link, or Reminder). The agent files it as Notes and links it.
- **Recall**: the Owner asks, and the agent answers from its Notes and Journal, and names the source.
- **Forget**: the Owner asks to delete something. The content is deleted for good, and the Journal keeps a Tombstone.
- **Brief**: the proactive daily message about what matters today.
- **Proactive Message**: a message the agent starts without a request. Every Proactive Message records an Outcome.
- **Outcome**: what the Owner did with a Proactive Message: acted, ignored, or muted.
- **Behavior Config**: the typed defaults for each Instance (texting style, quiet hours, budgets, proactivity limits).
- **Owner Preferences**: values in the Personal Agent that override the Behavior Config for one Owner, for example quiet hours or a "less of this" reply.
- **Quiet Hours**: the time when the agent sends no Proactive Messages.
- **Budget**: the limit on Proactive Messages per day and on tokens for background work, for each Owner.
- **Acknowledge**: the instant receipt signal (a reaction or "typing") that the Channel shows before the model runs.

## Safety and quality

- **Approval**: the Owner's explicit yes before an irreversible action, money, or a message sent in the Owner's name. Not needed in the MVP, because the MVP has no write tools.
- **Auto-review**: a separate reviewer model that checks each action before it runs. Comes with the first write tool.
- **Untrusted Content**: text from outside the Owner's own messages (web pages, mail, webhooks, tool output). It is data and never an instruction.
- **Trace**: the full record of a Turn: the prompt, injected state, tool calls, results, cost, latency, and cache hits. Enough to replay the Turn.
- **Eval**: a repeatable case that scores the full sequence of steps of a Turn. Measured as pass^k: it passes on every one of k runs.
- **Usage**: the tokens, messages, and cost for each Owner.

## Model

- **Model Gateway**: the one interface to all model providers. It picks the model for a task and the credentials for the Owner.
- **Model Credentials**: the provider key for one Owner. A self-host Instance uses the Operator's own key. The hosted product uses the platform key and bills the Usage.
