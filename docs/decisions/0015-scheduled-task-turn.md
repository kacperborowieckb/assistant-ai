# 0015: Scheduled Task Turn

Status: accepted

Date: 2026-11-16

Spec #66 (Schedule Actions), ticket #69. Supersedes the part of [0014](0014-schedule-actions.md) that says the `RunPrompt` handler comes in a later ticket. All other parts of 0014 and 0013 stay.

## Decision

- **Fire routing.** A `ScheduleFired` Event of a `RunPrompt` Schedule runs a Scheduled Task Turn. A `SendText` Schedule keeps the delivery by code.
- **Model Task.** The Turn uses the new Model Task `scheduled_task`. By default it uses the route of `reply`.
- **Input.** The system prompt has the sections of a reply Turn. A new section says that the Owner is not present and names the local time when the Schedule was set. The stored prompt is the input message with Trust Level `owner`. Text that tools return stays data.
- **Tools.** The Turn gets `search_notes`, `list_linked_notes`, and `list_schedules`. It gets no tool that writes. The step limit is `maxToolSteps`.
- **Result.** The result goes to the Owner Channel Conversation with no message to reply to. The prompt and the result enter the Conversation history. The Schedule then completes, or moves to its next occurrence, as for a Reminder.
- **Records.** The Trace has the task `scheduled_task`, the Schedule id, and the due instant. Its results are `scheduled_task_replied` and `scheduled_task_failed`. Usage is recorded under `scheduled_task`. The `ScheduleCompleted` or `ScheduleRescheduled` Journal Entry has the Schedule id.
- **Not in this record.** Lateness, the failure message, the token Budget, and `maxActiveScheduledTasks` come in tickets #70 and #71. The tools `list_schedules`, `change_schedule`, and `cancel_schedule` for `RunPrompt` Schedules come in ticket #72.

## Why

A stored prompt runs when the Owner is not present. A read-only tool set means that a prompt cannot change memory or create Schedules. One shared route keeps the first version simple.

## Revisit if

- A Scheduled Task needs a stronger or cheaper model than `reply`. Then add its own route.
- A Scheduled Task needs a tool that writes. Then add Approval first.
