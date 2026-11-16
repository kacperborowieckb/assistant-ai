import { DateTime, Effect } from "effect";

import { Schedules } from "../schedule/schedules.ts";
import { Inbox } from "./inbox.ts";

export const storeDueScheduleEvents = Effect.gen(
  function* storeDueScheduleEventsEffect() {
    const schedules = yield* Schedules;
    const inbox = yield* Inbox;
    const due = yield* schedules.unfiredDueBy(yield* DateTime.now);

    yield* Effect.forEach(
      due,
      ({ scheduleId, nextDueAt }) =>
        inbox.store({
          _tag: "ScheduleFired",
          scheduleId,
          dueAt: DateTime.formatIso(nextDueAt),
        }),
      { discard: true }
    );
  }
);
