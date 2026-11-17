# 0016: Scheduled Task failure and lateness

Status: accepted

Date: 2026-11-17

Spec #66 (Schedule Actions), ticket #70. Builds on [0014](0014-schedule-actions.md) and [0015](0015-scheduled-task-turn.md). All parts of those records stay.

## Decision

- **Failure message.** When the model fails or reaches the step limit, code sends one message. It names the Scheduled Task by its prompt, cut at 80 characters. It says that the task did not run.
- **Schedule after a failure.** The failure completes the Schedule at once. A one-time Scheduled Task becomes `done`. A repeating one moves to its next occurrence.
- **Trace.** The Trace has the result `scheduled_task_failed` and the error. The Journal has a `TurnFailed` entry before the message.
- **Lateness.** The grace period `reminderGraceMillis` applies. After it, the result starts with `This Scheduled Task is late. It was due <local time> (<time zone>): `. A `ReminderLate` Journal Entry records it.
- **Reset.** A reset after `TurnFailed` and before the send makes code send the failure message of the task. A reset after `SendStarted` sends no second message.

## Why

The Owner must know when a Scheduled Task did not run. Completing the Schedule at once means that a failure cannot stall a repeating Scheduled Task. The same late text style as a Reminder keeps one rule for the Owner.

## Revisit if

- The Owner wants a retry of a failed Scheduled Task.
- A failed one-time Scheduled Task must stay active for a later run.
