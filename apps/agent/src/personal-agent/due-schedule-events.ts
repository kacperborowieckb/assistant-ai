import { DateTime, Effect } from "effect";

import { Schedules } from "../schedule/schedules.ts";
import { Inbox } from "./inbox.ts";

export const fireDueSchedulesThen = <E, R>(
  queueTurn: Effect.Effect<void, E, R>
) =>
  Effect.gen(function* fireDueSchedulesEffect() {
    const schedules = yield* Schedules;
    const inbox = yield* Inbox;

    yield* schedules.fireDue((due) =>
      Effect.forEach(
        due,
        ({ scheduleId, nextDueAt }) =>
          inbox.store({
            _tag: "ScheduleFired",
            scheduleId,
            dueAt: DateTime.formatIso(nextDueAt),
          }),
        { discard: true }
      ).pipe(Effect.andThen(queueTurn))
    );
  });

export const storeDueScheduleEvents = fireDueSchedulesThen(Effect.void);
