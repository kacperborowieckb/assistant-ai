# 0018: A failed Reminder send completes the Schedule

Status: accepted

Date: 2026-11-18

Issue #81, part of #80. Supersedes the parts of [0013](0013-schedules-and-time.md) that keep the Schedule `active` after a failed or unconfirmed Reminder send. All other parts of 0013 stay, also the at-most-once rule.

## Decision

- **Schedule after a failure.** A failed send (`ReplyFailed`) or an unconfirmed send (a reset after `SendStarted`) completes the Schedule, as decision [0016](0016-scheduled-task-failure-and-lateness.md) does for a Scheduled Task. A one-time Reminder becomes `done`. A repeating Reminder moves to its next occurrence and writes a `ScheduleRescheduled` Journal Entry.
- **At most once.** There is no second send for the same due instant. The Inbox key (Schedule id, due instant) stays.
- **Order.** On a failed send, code completes the Schedule before it records the failure. A Turn that finds a recorded failure with no completed Schedule completes it. This covers a reset after `SendStarted` and a reset after the failure is recorded.
- **Alarm.** The alarm is armed for the next due instant only. A completed one-time Reminder leaves no alarm, so there is no hot loop.

## Why

The Inbox already has an Event for the due instant, so a Schedule that stays `active` never fires again. A repeating Reminder stopped for good after one failed send, and a one-time Reminder stayed `active` with nothing left to fire it. Completing the Schedule keeps the at-most-once rule and lets a repeating Reminder continue.

## Revisit if

- The Owner wants a retry of a failed Reminder.
- A failed one-time Reminder must stay `active` for a later send.
