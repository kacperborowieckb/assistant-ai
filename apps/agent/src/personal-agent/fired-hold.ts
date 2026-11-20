import { Effect, Option } from "effect";
import type { DateTime } from "effect";

import { Schedules } from "../schedule/schedules.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import type { proactiveHoldReasons } from "./storage-values.ts";

interface ProactiveHold {
  readonly event: ScheduleFiredEvent;
  readonly until: DateTime.Utc;
  readonly reason: (typeof proactiveHoldReasons)[number];
}

export const holdProactiveMessage = Effect.fnUntraced(
  function* holdProactiveMessage({ event, until, reason }: ProactiveHold) {
    const { database } = yield* AgentStorage;
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;
    const traces = yield* TurnTraces;

    yield* database.transaction(() =>
      Effect.gen(function* holdEffect() {
        const held = yield* schedules.hold({
          scheduleId: event.scheduleId,
          fromDueAt: event.dueAt,
          toDueAt: until,
          reason,
          eventId: event.eventId,
        });
        const recorded = yield* traces.readForEvent(event.eventId);
        if (Option.isSome(held) && recorded.length === 0) {
          yield* traces.record({
            eventId: event.eventId,
            task: "proactive_hold",
            result: "proactive_message_held",
            scheduleId: event.scheduleId,
            dueAt: event.dueAt,
            heldUntil: held.value,
            reason,
          });
        }
      })
    );
    yield* inbox.markDone([event]);
  }
);
