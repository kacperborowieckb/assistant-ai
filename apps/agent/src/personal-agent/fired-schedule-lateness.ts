import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import { isLate, lateByMillisOf } from "../schedule/late-reminder.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";

export const lateNoticeFor = Effect.fnUntraced(function* lateNoticeFor(
  behavior: BehaviorConfig,
  event: ScheduleFiredEvent
) {
  const journal = yield* Journal;
  const now = yield* DateTime.now;
  const dueAt = DateTime.makeUnsafe(event.dueAt);
  const lateByMillis = lateByMillisOf(now, dueAt);
  if (!isLate(lateByMillis, behavior.reminderGraceMillis)) {
    return Option.none();
  }
  const recorded = yield* journal.readForEvent(event.eventId);
  if (!recorded.some((entry) => entry.record._tag === "ReminderLate")) {
    yield* journal.append({
      _tag: "ReminderLate",
      eventId: event.eventId,
      scheduleId: event.scheduleId,
      dueAt: event.dueAt,
      lateByMillis,
    });
  }
  const timeZone = (yield* ownerTimeZone(behavior)).pipe(
    Option.getOrElse(() => DateTime.zoneMakeOffset(0))
  );
  return Option.some({ dueAt, timeZone });
});
