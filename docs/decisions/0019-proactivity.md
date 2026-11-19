# 0019: Proactivity

Status: accepted

Date: 2026-11-19

Spec #97 (Proactivity), ticket #102 (the default Brief). Builds on [0013](0013-schedules-and-time.md), [0014](0014-schedule-actions.md), [0015](0015-scheduled-task-turn.md), [0016](0016-scheduled-task-failure-and-lateness.md), [0017](0017-scheduled-task-limits.md), and [0018](0018-reminder-failure-completes-the-schedule.md). It supersedes only one rule of [0007](0007-typed-queries-and-migrations.md) (see Schema file). Reminders and Scheduled Tasks that the Owner sets do not change.

## Decision

- **Open Loop.** An Open Loop is optional metadata on a Note: a free-text kind, a state (`open`, or `closed` with the reason `done`, `dropped`, or `replaced`), and an optional due date. A fact has no Open Loop. Habits, chores, and external items are later kinds. The design does not block them.
- **Proactive Message.** A Proactive Message comes from a Schedule with `setBy: agent`. Owner-set Reminders and Scheduled Tasks are not Proactive Messages. Every Proactive Message records an Outcome.
- **Outcome.** The Outcome is what the Owner did with a Proactive Message: `acted`, `replied`, `muted`, or `ignored`. It is evidence for the agent, not a stop rule in code. Code keeps only the hard limits: Quiet Hours, the Budgets, and "less of this".
- **One gate.** One module decides every `ScheduleFired` Event of a Schedule with `setBy: agent` before any model call: `Send`, `Hold`, or `FoldIntoBrief`. It holds a message in Quiet Hours, keeps the daily send Budget, merges messages that are due close together, and keeps the daily token Budget `proactiveDailyTokenBudget`. Owner-set Schedules never reach it. Tickets #99 to #105 build it step by step.
- **Defaults.** Quiet Hours 22:00 to 08:00, 3 sends per day, the Brief at the end of Quiet Hours, a response window of 24 hours, a merge window of 30 minutes, 200000 proactive tokens per day, and 20 active agent Schedules. They are first guesses.
- **Quiet Hours and Budget as Owner Preferences.** The Owner changes them in the chat. Each stored value records its source: `owner` now, and later a Profile or an integration.
- **The Brief.** When the time zone of the Owner becomes known, code creates the Brief once: a Daily `RunPrompt` Schedule with `setBy: agent` at the end of the default Quiet Hours, in the Owner's time zone. A `BriefCreated` Journal Entry records it. Code checks the Journal for that entry, so a second time zone change creates no second Brief, and a cancelled Brief is not created again. The Owner moves, changes, and cancels it with the Schedule tools. A time zone change moves it with the other repeating Schedules.
- **Follow-ups.** The agent sets Follow-ups with `set_schedule`. Code sets `setBy: agent`, never the model. A Follow-up comes before the due date of an Open Loop, or after about a day with no change.
- **Untrusted Content.** A Turn for an Event with Trust Level `untrusted` gets no `set_schedule`, no Owner Preference tool, and no `mute_proactive_message`.
- **Evals.** There are no real-model Eval Cases for Open Loops, Follow-ups, Outcomes, or "less of this" now. This is a temporary path. The Evals come when the base set of MVP features works. Risk: the model can choose a wrong Open Loop or a wrong follow-up time, as #50 and #51 show for other tools.

### Decisions that later tickets build

- **Quiet Hours.** A fired agent Schedule in Quiet Hours makes no model call. The gate moves its due instant to the end of Quiet Hours in the local time of the Owner, also across a daylight saving change, and writes a `ProactiveMessageHeld` Journal Entry with the old and new instant. The Inbox key (Schedule id, due instant) stays the exactly-once rule: a held Schedule has a new due instant, so its next fire is a new key.
- **Send Budget.** The gate counts the Proactive Messages that were sent in the local day, from the Journal. At the Budget, a Follow-up folds into the next Brief. The Brief itself always runs. The Budget counts sends, not items.
- **Merge.** When the gate sends, it takes every other agent Schedule that is due within the merge window or held, and runs them as one Turn with all their Open Loops, so the agent writes one message. A Brief that is due within the window takes the Follow-ups.
- **Token Budget and active limit.** Over `proactiveDailyTokenBudget`, Follow-ups fold and make no model call. `maxActiveAgentSchedules` (20) is separate from `maxActiveScheduledTasks`.
- **Brief and Quiet Hours.** When the Owner changes Quiet Hours, the Brief keeps its own time unless it was at the old end of Quiet Hours. Then it moves to the new end.
- **Outcome connection.** Code connects the next Owner message to the last Proactive Message when it comes before the next Proactive Message and within the response window. The window includes its exact end: a message at the window is connected, one millisecond later is not. A second Proactive Message ends the connection. The connected Turn sees the Proactive Message and its Open Loops in its system prompt.
- **Outcome rules.** `acted`: an Open Loop of the message opens, changes, or closes in a connected Turn. `replied`: a connected Turn changes none. `muted`: the Owner says "less of this". `ignored`: no connected message in the window; code records it when the window ends, through the alarm of the Schedules store, with no model call. An Outcome is recorded once, the first rule wins, and `muted` replaces `replied` in the same Turn. A `ProactiveMessageOutcome` Journal Entry records it. No code rule stops Follow-ups after `ignored` Outcomes; the agent sees the recent Outcomes and changes its approach.
- **"Less of this".** The tool `mute_proactive_message` saves an Owner Preference: fewer Follow-ups for the Open Loops of the connected message (default) or for their kind. A muted Open Loop appears only in the Brief. "Stop" is different: it closes the Open Loop or cancels the Schedule. The Owner can undo it with the same tool.
- **Setting Follow-ups.** `set_schedule` with Open Loop ids, when the Owner did not ask for a Schedule in the Turn, gets `setBy: agent` from code. A link table connects Schedules to Notes.

### What ticket #102 builds

- **Proactive path.** A fired Schedule with `setBy: agent` and the `RunPrompt` Action goes to the proactive path, not to the Scheduled Task Turn. The Model Task is `proactive`. Its Usage rows, the Trace, and the Budget count use that name.
- **Tools of a proactive Turn.** It has the read tools (`search_notes`, `list_linked_notes`, `list_schedules`) and the Open Loop tools `list_open_loops` and `close_open_loop`. The system prompt allows a close only when the Notes already show that the Open Loop is done or dropped. It has no other tool that changes anything, and no Owner Preference tool.
- **Open Loops in reach.** Before the model call, code reads up to 20 open Open Loops, due first. It lists them in the system prompt and records their ids in the Proactive Message row. The row exists before the send, so a reset cannot change which Open Loops the message is about.
- **Proactive Message row.** The table `proactive_messages` has the Event id, the sent message id (null until the send is confirmed), the Open Loop ids, the Outcome (null while open), and the planned time. Recovery after a reset sets the sent message id from the Delivery state.
- **Token Budget.** `proactiveDailyTokenBudget` is read from Usage records of the Model Task `proactive`, as in [0017](0017-scheduled-task-limits.md). In this ticket the Brief always runs. The tokens spent before the Turn are in its Trace. A later ticket makes follow-ups fold when the Budget is spent.
- **Failure.** A proactive Turn that fails sends no failure notice, because the Owner did not ask for it. The Schedule completes before the Event is marked failed, so a reset between the two steps cannot leave the Brief at an old due instant. The Brief moves to the next day. A send that fails or is not confirmed also completes the Schedule. Recovery after a reset follows the same rules.
- **Lateness.** A Brief that fires late says when it was planned, as a Scheduled Task does.
- **Schema file.** `storage-schema.ts` is at the 250-line limit of the `max-lines` rule. The table `proactive_messages` is in `src/proactive/proactive-schema.ts`, and the Drizzle config of the Personal Agent lists both files. This supersedes the rule of 0007 that a store has one table schema file. The new rule: the table schema files of a store (`storage-schema.ts` and the files that its Drizzle config lists) are together its single source of truth, and each table is in exactly one of them. All other parts of 0007 stay.
- **Active limit.** The active limit `maxActiveScheduledTasks` counts only Schedules that the Owner set, so the Brief does not use the room of the Owner.
- **Records.** The Trace of a proactive Turn is written before the send, like every Trace, so a reset cannot lose it: the result `proactive_message_sent` says that the model answered and the message went to delivery. When the send fails or no Owner Channel Conversation exists, code appends a second Trace with the result `proactive_message_failed`, and the last Trace of the Event is the true one. A model failure writes only `proactive_message_failed`. The Trace has the Budget and the tokens spent before the Turn. The Operator metric of the kind `proactive_message` has the Event id in `blob5` and no content. Recovery after a reset writes it again when it finds a confirmed send, as for other metrics (0017). The Journal records `BriefCreated`.
- **Local proof.** `pnpm control request` with the fake model shows a Brief: the fake `brief soon` message moves the Brief to the next minute with the existing Schedule tools.

## Why

The MVP promises that the agent comes to the Owner first. Limits in code keep that useful and not annoying, and the recorded Outcomes let the Operator tune the behavior. A Brief with its own Schedule and its own Model Task needs no new scheduler: it uses the Schedules store, the alarm, and the exactly-once rules that exist.

## Revisit if

- Real Outcomes show that the defaults are wrong.
- A second source (a Profile, sleep data) sets Quiet Hours.
- Habits or MCP items need more Open Loop state than `open` and `closed`.
