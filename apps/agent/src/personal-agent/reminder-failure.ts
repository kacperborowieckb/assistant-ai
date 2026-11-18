import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";

export const completeScheduleOfFailedReminder = Effect.fnUntraced(
  function* completeScheduleOfFailedReminder(event: ScheduleFiredEvent) {
    const journal = yield* Journal;
    const schedules = yield* Schedules;
    const tags = new Set(
      (yield* journal.readForEvent(event.eventId)).map(
        (entry) => entry.record._tag
      )
    );
    const failed = tags.has("ReplyFailed") || tags.has("TurnFailed");
    const schedule = yield* schedules.byId(event.scheduleId);
    if (
      failed &&
      !tags.has("ReplySent") &&
      schedule._tag === "Some" &&
      schedule.value.action._tag === "SendText"
    ) {
      yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    }
  }
);
