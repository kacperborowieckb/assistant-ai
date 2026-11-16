import { DateTime, Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { OwnerId } from "../owner-id.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { deliverReminder } from "./reminder-delivery.ts";

export const fireSchedule = Effect.fnUntraced(function* fireSchedule(
  ownerId: OwnerId,
  behavior: BehaviorConfig,
  event: ScheduleFiredEvent
) {
  const inbox = yield* Inbox;
  const schedules = yield* Schedules;
  const schedule = yield* schedules.byId(event.scheduleId);
  const stillDue =
    schedule._tag === "Some" &&
    schedule.value.state === "active" &&
    DateTime.formatIso(schedule.value.nextDueAt) === event.dueAt;
  if (!stillDue) {
    yield* inbox.markDone([event]);
    return;
  }
  const { action } = schedule.value;
  switch (action._tag) {
    case "SendText": {
      return yield* deliverReminder({ ownerId, behavior, event, action });
    }
    case "RunPrompt": {
      return yield* Effect.die("No handler exists yet for a RunPrompt Action");
    }
    default: {
      return action satisfies never;
    }
  }
});
