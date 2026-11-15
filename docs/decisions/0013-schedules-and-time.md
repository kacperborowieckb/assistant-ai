# 0013: Schedules and time

Status: accepted

Date: 2026-11-15

Specs #52 (Schedules and Reminders) and #53 (Owner time zone and current time in each Turn). Builds on [0003](0003-runtime-and-model-stack.md), [0007](0007-typed-queries-and-migrations.md), and [0009](0009-agent-loop-and-client-boundaries.md).

## Decision

- **Schedule store.** A new `schedule` module owns a `schedules` table in the Personal Agent SQLite (versioned migration). The table is the only source of truth. A Schedule has: Schedule id, Owner Id, kind (`reminder`; `brief` and `proactive` come later, so the kind is a closed union that grows), set by (`owner` or `agent`), text, optional Note id, next due instant (UTC), optional recurrence rule, state (`active`, `done`, `cancelled`), and created and changed instants.
- **One alarm.** The Agents SDK is only the alarm (decision 0003: the SDK sits behind our own interfaces). The Personal Agent keeps one SDK Schedule at the earliest next due instant of all active Schedules, and arms it again after each change and each fire. It does not use one SDK Schedule for each Reminder, and it does not use the SDK cron, because the cron has no time zone.
- **A fired Schedule is an Event.** `Event` becomes a union of `OwnerMessage` and `ScheduleFired`. When the alarm runs, each due Schedule enters the Inbox as a `ScheduleFired` Event. The Inbox key is (Schedule id, due instant), so a repeated alarm writes no second Event. Owner messages still go first.
- **Delivery by code.** The model writes the Reminder text when the Owner sets it. At the due time, code sends the saved text through the Channel send action, with no model call. When the Event is handled more than a set grace period after the due instant, the message says that it is late and gives the due time. After a confirmed send, a one-time Schedule becomes `done` and a repeating Schedule gets its next due instant. A failed send follows the existing honest-failure rules and is recorded.
- **Send that is not a reply.** The Channel send action takes an optional message to reply to. A Reminder goes to the Owner's Channel conversation, which the Personal Agent knows from the Owner's messages.
- **Not a Proactive Message.** The Owner asked for the Reminder, so Quiet Hours and the Budget do not apply to it, and it records no Outcome.
- **Time zone is an Owner Preference.** The Owner's time zone is a typed Owner Preference: an IANA name, checked with `DateTime.zoneMakeNamed`. Owner Preferences live in the `owner_preferences` table of the Personal Agent SQLite (versioned migration). Each row has a key from a closed union, a JSON value that a Schema for that key checks on every read and write, the source Event, and the change instant. Each change appends an `OwnerPreferenceChanged` Journal Entry. The Behavior Config has an optional `defaultTimeZone` for each Instance, and the Owner Preference overrides it. Code stores the name in the form that `DateTime` returns, so the case of the name is normalized.
- **Current time in every Turn.** Every Turn adds the local date, weekday, time, and time zone of the Owner to the model input, or says that the time zone is not known. Code reads the time from the Effect `Clock`, so tests use `TestClock`. The text is the last section of the system prompt, after the static sections and the Profile, so a change of the time does not break the prompt cache of the sections before it. When the time zone is not known, the agent asks the Owner before it sets a Reminder.
- **`set_time_zone` tool.** Only an Event with Trust Level `owner` gets the tool. An invalid name returns a message for the model and changes nothing.
- **Time math with Effect `DateTime`, no new library.** Effect 4.1.4 `DateTime` is already a dependency. Use `makeZoned` with `adjustForTimeZone: true` and `disambiguation: "later"`: a local time in a daylight saving gap moves forward and never fires early, and a repeated local time fires once, at the later instant. Use calendar-unit `add` for days, weeks, and months, so the wall clock stays the same.
- **Not used.** Native `Temporal`: Workers do not document it, and a runtime release in August 2026 exposed it with a clock stuck at epoch 0 ([Cloudflare Status incident 6138](https://pulsetic.com/status/cloudflare/incidents/6138/)). `date-fns-tz`, Luxon, and Day.js: they add a second time library for what `DateTime` does. `rrule`: it covers far more than Daily, Weekly, and Monthly, and its time zone handling is not ours to check. The SDK cron: it has no time zone.
- **Recurrence rule.** Our own tagged union, checked by an Effect `Schema` and stored as JSON: `Daily { time }`, `Weekly { weekdays, time }`, `Monthly { day | "last", time }`, where `time` is a local `HH:mm`. One pure function `nextOccurrence(rule, after, timeZone)` gives the next due instant. A repeating Schedule stores the time zone that its local time uses. When the Owner changes the time zone, the agent recomputes the next due instants of active Schedules from the new time zone.
- **Monthly day that a month does not have.** A `Monthly` rule with a day that the month lacks (31 in April, or 29 to 31 in February) fires on the last day of that month. `Monthly` with `"last"` fires on the last day of every month.
- **Model input is local, code converts.** The Reminder tools take a local date and time (`YYYY-MM-DDTHH:mm`) or a recurrence rule. Code converts with the Owner's time zone. The model never computes a UTC offset. A due time in the past is refused with a message for the model.
- **Tools.** `set_reminder`, `list_reminders`, `change_reminder`, and `cancel_reminder`. Tool calls follow the existing tool-call and step recording, so a repeated call after a crash writes nothing new. Code sets "set by" from the Event, not from the model. Only an Event with Trust Level `owner` gets the Reminder tools that write.
- **Journal and Trace.** Each Schedule set, change, cancel, and fire appends a Journal Entry with the Schedule id. A delivered Reminder has a Trace with no model call.

## Why

The vision wants an agent that comes to the Owner, so the Schedule is a primitive that Reminders, the Brief, and self-set proactive work share, built in its long-term form. Our own store with one alarm gives exact control over time zones, lateness, and exactly-once delivery, which the SDK cron and one SDK Schedule for each Reminder do not give. Delivery by code makes a Reminder cheap, fast, and safe from model errors at the due time. `DateTime` already handles zones and daylight saving rules, so a new library adds weight and a second source of truth. The model gets the local time as text and gives local times back, so it never does UTC math, which it does badly.

## Revisit if

- Cloudflare documents native `Temporal` for Workers and its clock is reliable.
- A rule needs more than Daily, Weekly, and Monthly.
- A Reminder needs model context at fire time.
