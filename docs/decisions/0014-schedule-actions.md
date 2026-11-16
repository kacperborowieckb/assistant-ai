# 0014: Schedule Actions

Status: accepted

Date: 2026-11-16

Spec #66 (Schedule Actions), first ticket #67 (Prefactor: Action in the Schedule store). Partly supersedes [0013](0013-schedules-and-time.md): the Schedule kind, "Delivery by code" as the only fire behavior, and the four Reminder tools. All other parts of 0013 stay.

## Decision

- **An Action replaces the kind.** A Schedule has one Action, from a closed union: `SendText` and `RunPrompt`. `SendText` is the Reminder of 0013: code sends fixed text with no model call. `RunPrompt` is a Scheduled Task: at the due time, the agent runs a model Turn with the stored prompt and sends the result. The union grows only by a new decision.
- **Store.** A versioned migration replaces the `kind` column of `schedules` with an `action` column (`send_text` or `run_prompt`, with a check constraint). Every existing row becomes `send_text`. The `text` column keeps the text of `SendText` and the prompt of `RunPrompt`. The Inbox key (Schedule id, due instant), the one alarm, recurrence, repeating delivery, and the time zone rules do not change.
- **The Schema is the only reader.** In code, the Action is an Effect `Schema` tagged union: `SendText { text }` and `RunPrompt { prompt }`. A second Schema maps the pair of columns `action` and `text` to the union and back. Code never reads the raw columns without it.
- **Fire routing.** A `ScheduleFired` Event goes to the handler for the Action of its Schedule. The `SendText` handler is the delivery by code of 0013. The `RunPrompt` handler is a Scheduled Task Turn (ticket #69): Model Task `scheduled_task` (the `reply` route by default), the system prompt sections of a reply Turn plus a section that says the Owner is not present, the stored prompt as the input message with Trust Level `owner`, and only the read tools `search_notes`, `list_linked_notes`, and `list_schedules`. The result goes to the Owner Channel Conversation with no message to reply to, and the prompt and the result enter the Conversation history. Its Trace has the task `scheduled_task`. The tools `set_schedule`, `list_schedules`, `change_schedule`, and `cancel_schedule` replace the four Reminder tools of 0013; `set_schedule` accepts both Actions, and `list_schedules`, `change_schedule`, and `cancel_schedule` still touch `SendText` Schedules only until the ticket for them (#72). The failure, lateness, and Budget behavior of a Scheduled Task comes in tickets #70 and #71.
- **Temporary path for Evals.** Spec #66 adds no new Eval cases. Real-model Eval cases for Schedule Actions (the right Action for a request, read-only tools, and the Budget) are added before the MVP release. Reason: the product first gets its full set of features, then Evals cover the most important behavior. Risk: the model can choose the wrong Action, as #50 and #51 show for other tools.

## Why

The repository wants few general primitives. The Schedule is already the primitive for work at a time. A second Action gives the Owner work at a time, such as "every weekday at 8:00, tell me my open tasks", with no separate Brief feature. A closed union, read through one Schema, keeps every fire path checked by the compiler. The store changes first, with no change for the Owner, so the later tickets add behavior on a store that already holds the Action.

## Revisit if

- A third kind of Action is needed.
- The shared `text` column makes a query or a migration for one Action hard to write. Then split it into one column for each Action.
