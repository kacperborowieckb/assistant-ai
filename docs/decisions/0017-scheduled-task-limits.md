# 0017: Scheduled Task Token Budget and active limit

Status: accepted

Date: 2026-11-17

Spec #66 (Schedule Actions), ticket #71. Builds on [0014](0014-schedule-actions.md), [0015](0015-scheduled-task-turn.md), and [0016](0016-scheduled-task-failure-and-lateness.md). All parts of those records stay.

## Decision

- **Token Budget.** The Behavior Config has `scheduledTaskDailyTokenBudget`, default 200000. It is the tokens that Scheduled Task Turns of one Owner may spend in one local day.
- **Spent tokens.** Code reads the Usage records of the Model Task `scheduled_task` since the start of the local day of the Owner. It sums their input and output tokens. Records of `reply` and `eval_judge` do not count. Unknown token counts count as zero.
- **Local day.** The local day uses the time zone of the Owner. When no time zone is known, it uses UTC, as the late notice does. The Usage ledger writes its time with the Effect clock, so `TestClock` moves it.
- **Check.** Code checks the Budget once, before the first model step of a Turn. If the spent tokens are at or above the Budget, code makes no model call.
- **Started Turn.** A Turn that already has a recorded model step is not checked again. It finishes, and its tokens count.
- **Skip.** The Owner gets one message: the Scheduled Task, named by its redacted prompt, was skipped because of the daily limit. The Schedule completes at once, so a repeating Scheduled Task moves to its next occurrence.
- **Skip records.** The Journal has a `ScheduledTaskSkipped` entry with the Budget and the spent tokens. The Trace has the result `scheduled_task_skipped`, the Budget, and the spent tokens. It has no model fields. An Operator metric of the kind `scheduled_task_skipped` has no content.
- **Active limit.** The Behavior Config has `maxActiveScheduledTasks`, default 10. `set_schedule` refuses a new `RunPrompt` Schedule when the Owner has that many active ones. It returns a message for the model. A `SendText` Schedule is not limited.
- **Same limit on change.** `change_schedule` refuses to change a `SendText` Schedule into a `RunPrompt` Schedule at the limit. Without this rule, the limit has a gap.
- **Reset after a skip.** A reset after the `ScheduledTaskSkipped` entry and before the send makes the next Turn finish the skip. It writes the Trace and metric if they are missing, completes the Schedule, and sends the message once, under the rule for unconfirmed sends.
- **Metric delivery.** A reset never loses a skip metric, and it can repeat it. A repeat carries the same Event id, and readers count distinct Event ids. A Journal marker cannot give exactly-once, because a reset between the metric write and the marker write still repeats it.
- **Limit of delivery.** All Operator metrics stay best-effort. A write that Analytics Engine rejects is logged and dropped. A normal Turn metric is written after the send, so a reset can lose it. A durable outbox for metrics is out of scope.
- **Event id on metrics.** Every Operator metric for an Event has its Event id as `blob5`: turn, reminder, and `scheduled_task_skipped`. A refused request has no Event, so `blob5` is empty. The first four blobs and the index keep their positions.
- **Trace lookup.** Recovery finds the Trace of an Event by Event id and does not read all Traces.
- **Replay.** A repeated `set_schedule` call that finds its stored Schedule returns it before the limit check. A reset cannot make a stored Schedule look like a new one.
- **Defaults.** Both default values are first guesses. The Operator may change them in the Behavior Config.

## Why

A repeating prompt costs tokens with no Owner present. A daily limit bounds the cost of one Owner. A check before the first step keeps the rule simple, and a Turn that started is not cut off. A skip message tells the Owner that the work did not run.

## Revisit if

- Real Usage shows that 200000 tokens is too high or too low.
- The Owner wants to raise the limit for one day.
- One Turn must stop when it passes the Budget.
