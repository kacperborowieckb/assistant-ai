import { DateTime, Effect } from "effect";

import { Schedules } from "../schedule/schedules.ts";
import { Inbox } from "./inbox.ts";

export const storeDueScheduleEvents = Effect.gen(
  function* storeDueScheduleEventsEffect() {
    const schedules = yield* Schedules;
    const inbox = yield* Inbox;

    yield* schedules.fireDueBy(yield* DateTime.now, (due) =>
      Effect.forEach(
        due,
        ({ scheduleId, nextDueAt }) =>
          inbox.store({
            _tag: "ScheduleFired",
            scheduleId,
            dueAt: DateTime.formatIso(nextDueAt),
          }),
        { discard: true }
      )
    );
  }
);
