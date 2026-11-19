# 0019: Proactivity

Status: accepted

Date: 2026-11-19

Spec #97 (Proactivity), ticket #102 (the default Brief). Builds on [0013](0013-schedules-and-time.md), [0014](0014-schedule-actions.md), [0015](0015-scheduled-task-turn.md), [0016](0016-scheduled-task-failure-and-lateness.md), [0017](0017-scheduled-task-limits.md), and [0018](0018-reminder-failure-completes-the-schedule.md). It supersedes none of them. Reminders and Scheduled Tasks that the Owner sets do not change.

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

### What ticket #102 builds

- **Proactive path.** A fired Schedule with `setBy: agent` and the `RunPrompt` Action goes to the proactive path, not to the Scheduled Task Turn. The Model Task is `proactive`. Its Usage rows, the Trace, and the Budget count use that name.
- **Tools of a proactive Turn.** It has the read tools (`search_notes`, `list_linked_notes`, `list_schedules`) and `list_open_loops`. It has no tool that changes anything, and no Owner Preference tool. Only the Owner closes an Open Loop, so it has no `close_open_loop`.
- **Open Loops in reach.** Before the model call, code reads up to 20 open Open Loops, due first. It lists them in the system prompt and records their ids in the Proactive Message row. The row exists before the send, so a reset cannot change which Open Loops the message is about.
- **Proactive Message row.** The table `proactive_messages` has the Event id, the sent message id (null until the send is confirmed), the Open Loop ids, the Outcome (null while open), and the planned time. Recovery after a reset sets the sent message id from the Delivery state.
- **Token Budget.** `proactiveDailyTokenBudget` is read from Usage records of the Model Task `proactive`, as in [0017](0017-scheduled-task-limits.md). In this ticket the Brief always runs. The tokens spent before the Turn are in its Trace. A later ticket makes follow-ups fold when the Budget is spent.
- **Failure.** A proactive Turn that fails sends no failure notice, because the Owner did not ask for it. The Schedule completes, so the Brief moves to the next day. A send that fails or is not confirmed also completes the Schedule. Recovery after a reset follows the same rules.
- **Lateness.** A Brief that fires late says when it was planned, as a Scheduled Task does.
- **Schema file.** `storage-schema.ts` is at the 250-line limit of the `max-lines` rule. The table `proactive_messages` is in `src/proactive/proactive-schema.ts`, and the Drizzle config of the Personal Agent lists both files. [0007](0007-typed-queries-and-migrations.md) stays: the schema files of a store are its single source of truth, and each table is in one of them.
- **Active limit.** The active limit `maxActiveScheduledTasks` counts only Schedules that the Owner set, so the Brief does not use the room of the Owner.
- **Records.** The Trace result is `proactive_message_sent` (or `proactive_message_failed`), with the Budget and the tokens spent before the Turn. The Operator metric of the kind `proactive_message` has the Event id in `blob5` and no content. The Journal records `BriefCreated`.
- **Local proof.** `pnpm control request` with the fake model shows a Brief: the fake `brief soon` message moves the Brief to the next minute with the existing Schedule tools.

## Why

The MVP promises that the agent comes to the Owner first. Limits in code keep that useful and not annoying, and the recorded Outcomes let the Operator tune the behavior. A Brief with its own Schedule and its own Model Task needs no new scheduler: it uses the Schedules store, the alarm, and the exactly-once rules that exist.

## Revisit if

- Real Outcomes show that the defaults are wrong.
- A second source (a Profile, sleep data) sets Quiet Hours.
- Habits or MCP items need more Open Loop state than `open` and `closed`.
