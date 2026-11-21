# Context: ubiquitous language

Use these terms with these meanings in code, docs, issues, and prompts. Use the term, not a synonym. If you need a new term, add it here in the same change.

## Product

- **Billy**: the name of the product and of its mascot, Billy the Beaver. Billy is the face of the Personal Agent in the app and on the site. Use "Billy" in copy for the Owner; use "Personal Agent" and "Instance" for the runtime parts. The Cloudflare resources still use the old working name `assistant` until [#159](https://github.com/kacperborowieckb/billy/issues/159).

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
- **Turn**: one run of the agent loop, from the Events it takes in to the messages and Journal Entries it produces. An Owner message Turn answers one Burst: it takes every Event of the Burst as its input, in arrival order, and is keyed by the first Event of the Burst (the Turn Event), so its Delivery, Turn progress, Conversation, Trace, and metric keep the same key when the Burst grows.
- **Burst**: the pending Owner message Events that one Turn answers, in arrival order. Before the model call, an `AnsweredByTurn` Journal Entry links each other Event of the Burst to the Turn Event, so recovery after a reset settles them from the Delivery of that Turn and does not answer them again. A pending Event that no Turn linked never joins a Turn whose Delivery has started; it waits for a new Burst. A Burst waits for the Quiet Gap after its newest message, and at most `burstMaxWaitMillis` after its first message, before its Turn starts. When an Owner message arrives while the Turn runs, before it sends, the Turn restarts (Restart). The model input labels each message of a Burst of several Events `[Message n of m]`, and a Note captured in that Turn names the message it keeps by that number.
- **Restart**: what an Owner message Turn does when another Owner message arrives before it sends: it drops its answer, sends nothing, writes a restart record (an `EventReceived` Entry with a `restart` field, so an earlier version can read it) and a Trace, and a new Turn starts after the Quiet Gap with every message of the Burst, including the new one, so the Owner gets one combined outcome. Tool calls that finished stay done: the new Turn gets them as completed steps, as after a reset. There are at most `burstMaxRestarts` restarts (default 2) and none once `burstMaxWaitMillis` has passed since the first message; then the Turn sends, and a later message gets its own Turn. A message that arrives after the send gets its own Turn too (decision 0025).
- **Model Turn**: the one module that runs a Turn which calls the model: the step limit, the model call through the Model Gateway, the Trace, the failure branches, the Conversation write, and the metric. The reply Turn and the Scheduled Task Turn each give it only what differs. It sends through Delivery.
- **Fired Schedule**: the one module that handles a `ScheduleFired` Event: it reads the Schedule once, checks that it is still due, applies the lateness rule for its Action, sends the text of a Reminder or runs the Budget check and a Model Turn for a Scheduled Task, completes the Schedule, and recovers after a reset through the Delivery state. The Turn loop only routes Events to it.
- **Delivery**: the record of the one outcome that the agent delivers for a Turn (for an Owner message Turn, for its Burst, keyed by the Turn Event; a reply or a reaction goes to the newest message of the Burst), and its state. The outcome kinds are `reply` (a text message), `reaction` (one emoji on the newest Owner message, with no text; the model chooses it with `react`), and `silent` (no Channel call, for small talk such as "ok"; the model chooses it with `stay_silent`). The states are `Unsent`, `Sent`, `Silent`, `SendFailed`, `Unconfirmed`, `ReactionUnconfirmed`, or a failed Event with a notice that is pending, sent, refused, or unconfirmed. `Silent` is final: recovery never sends for that Event, and the other Events of its Burst are done. A reaction is one send with the same states as a text; an unconfirmed reaction is sent once more, in the Turn or by recovery after a reset to the message its plan recorded, because setting a reaction twice gives the same result. The newest of the reaction plan and the text plan decides the state. Code refuses silence in a Turn that changed Owner data or in which a changing tool call failed, refuses a reaction in a Turn in which a changing tool call failed, and a failed model call always sends the honest failure text. The outcome kind is not the Outcome of a Proactive Message. Only the Delivery module reads and writes the delivery Journal Entries.
- **Outcome tool**: a tool that the model calls to end a Turn with an outcome other than a text reply, such as `stay_silent` or `react`. It does nothing by itself: code decides the call after the tool loop, and a refusal goes back to the model as the tool result (decisions 0021 and 0023).
- **Helper**: a durable workflow that does long or expensive work outside the chat Turn and returns only its result. Not in the MVP.

## Primitives

- **Channel**: an adapter between the agent and the Owner (for example Telegram). It receives messages and turns them into Events. It shows the agent's one send action in its own way (a text or a reaction), and the typing signal (Acknowledge) while a Turn for an Owner message runs. The Channel keeps the list of reactions that it allows, and a close match for some emoji that are not on it.
- **Channel Identity**: the Owner's identity inside a Channel, for example a Telegram user id. The Directory maps it to an Owner Id.
- **Event**: a signal that wakes the agent: an Owner message, a fired Schedule, a finished Helper, or a webhook. Every Event enters the Inbox.
- **Inbox**: the queue of Events for one Owner. The router drops duplicates, merges the pending Owner messages into one Burst once the Quiet Gap passes, and puts Owner messages first.
- **Quiet Gap**: the time with no new Owner message (`burstQuietMillis`, default 2500 ms) after which a waiting Burst is answered. It is not Quiet Hours.
- **Owner Channel Conversation**: the Channel and the conversation id where the Owner last wrote. The agent sends there when it has no message to reply to. The Personal Agent keeps it from the Owner's messages.
- **Schedule**: a wake-up time with one Action.
- **Action**: what a Schedule does when it fires: `SendText` or `RunPrompt`.
- **Reminder**: a Schedule that the Owner asks for, with the `SendText` Action.
- **Scheduled Task**: a Schedule with the `RunPrompt` Action. The Owner sets it, or the agent sets it for itself (`setBy: agent`); a Schedule that the agent set is a Proactive Message when it fires.
- **Document**: something the agent writes, for itself or for the Owner. A Note is the main kind.
- **Note**: a small, linked unit of memory with metadata: source, trust level, and the date it was last checked.
- **Open Loop**: something that the Owner or the agent expects to come back to. Optional metadata on a Note: a kind (free text, for example task), a state (`open`, or `closed` with the reason `done`, `dropped`, or `replaced`), an optional due date, and (later) the Schedules that check on it. A fact has no Open Loop.
- **Profile**: the short core facts and style rules about the Owner. The agent adds them to every Turn, and compaction never drops them.
- **Skill**: repeated work saved for reuse, with the tools it names. Loaded only when needed. Not in the MVP.
- **Journal**: the append-only log of every action and its result for one Owner. The agent reads it and cannot edit it.
- **Journal Entry**: one record in the Journal.
- **Tombstone**: the Journal Entry that a Forget leaves: what was deleted and when, without the content.

## Behavior

- **Capture**: the Owner sends something to keep (a note, task, link, or Reminder). The agent files it as Notes and links it.
- **Recall**: the Owner asks, and the agent answers from its Notes and Journal, and names the source.
- **Forget**: the Owner asks to delete something. The content is deleted for good, and the Journal keeps a Tombstone.
- **Brief**: the daily Proactive Message about what matters today. It is a `RunPrompt` Schedule with `setBy: agent`, that code creates when the Owner's time zone becomes known.
- **Proactive Message**: a message from a Schedule that the agent set (`setBy: agent`). Owner-set Reminders and Scheduled Tasks are not Proactive Messages. Every Proactive Message records an Outcome.
- **Follow-up**: a Proactive Message about one or more Open Loops, from a Schedule that the agent set.
- **Merge**: when the gate sends a Proactive Message, it takes every other agent Schedule with a prompt (not the Brief) that is due within the merge window (default 30 minutes) into the same Turn, so the agent writes one message that counts as one send for the Budget. A follow-up that is due when the Brief is due within the window folds into the Brief.
- **Outcome**: what the Owner did with a Proactive Message: `acted`, `replied`, `muted`, or `ignored`. Code connects the next Owner message to the last Proactive Message, when it comes within the response window. An Outcome is recorded once.
- **Behavior Config**: the typed defaults for each Instance (texting style, quiet hours, budgets, proactivity limits, the default reaction, the Burst wait and restart limits).
- **Owner Preferences**: values in the Personal Agent that override the Behavior Config for one Owner, for example Quiet Hours or a "less of this" reply. Each stored value records its source (`owner` now).
- **Mute**: the Owner Preference from a "less of this" reply: the Open Loops of a Proactive Message, or their kind. A muted Open Loop gets no follow-up of its own and appears only in the Brief. "Less" means less often, not never; "stop" closes the Open Loop or cancels the Schedule. The Owner can undo it in the chat.
- **Quiet Hours**: the local time range when the agent sends no Proactive Messages (default 22:00 to 08:00). Code holds a Proactive Message that is due in Quiet Hours and moves it to the end of Quiet Hours. The Owner changes them in the chat, and the stored value records its source. Reminders and Scheduled Tasks that the Owner set still arrive.
- **Budget**: the limit on Proactive Messages per local day (sends, not items) and on tokens for background work, for each Owner. The Owner can change the send Budget in the chat. A follow-up over the Budget folds into the next Brief, and the Brief always runs.
- **Acknowledge**: the instant receipt signal (a reaction or "typing") that the Channel shows before the model runs. Telegram shows "typing" (`sendChatAction`) once for each Owner message of a Burst that waits for its Quiet Gap, and from the start of the Turn of an Owner message until its outcome is sent. It is best-effort and is not a Delivery.

## Safety and quality

- **Approval**: the Owner's explicit yes before an irreversible action, money, or a message sent in the Owner's name. Not needed in the MVP, because the MVP has no write tools.
- **Auto-review**: a separate reviewer model that checks each action before it runs. Comes with the first write tool.
- **Trust Level**: the mark on a Note and on an Event that says where its text came from: `owner` for the Owner's own words, `untrusted` for Untrusted Content. Code sets it from the Event, never from the model.
- **Untrusted Content**: text from outside the Owner's own messages (forwarded messages, web pages, mail, webhooks, tool output). It is data and never an instruction.
- **Trace**: the full record of a Turn: the prompt, injected state, tool calls, results, cost, latency, and cache hits. Enough to replay the Turn.
- **Eval**: a repeatable case that scores the full sequence of steps of a Turn. Measured as pass^k: it passes on every one of k runs.
- **Eval Case**: one Eval: the Notes and Profile entries to seed (optional), the Owner Events to send, and the checks on storage, the Trace, and the replies.
- **Judge**: the model that checks the replies of an Eval Case against the fixed rubric of the case. It is its own Model Task, `eval_judge`.
- **Usage**: the tokens, messages, and cost for each Owner.

## Model

- **Model Gateway**: the one interface to all model providers. It picks the model for a task and the credentials for the Owner.
- **Model Credentials**: what the Model Gateway uses to call models for one Owner: the AI Gateway token and the billing mode. A self-host Instance uses Unified Billing with the Operator's Cloudflare credits by default, or the Operator's own provider key (BYOK). The hosted product uses the platform's credits and bills the Usage.
