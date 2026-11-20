import { Effect, Option } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { activeBriefScheduleId } from "../schedule/brief.ts";
import { Schedules } from "../schedule/schedules.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import type { proactiveFoldReasons } from "./storage-values.ts";

interface ProactiveFold {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly openLoopIds: readonly string[];
  readonly reason: (typeof proactiveFoldReasons)[number];
  readonly budget?: number;
  readonly used?: number;
}

export const foldProactiveMessage = Effect.fnUntraced(
  function* foldProactiveMessage({
    ownerId,
    event,
    openLoopIds,
    reason,
    budget,
    used,
  }: ProactiveFold) {
    const { database } = yield* AgentStorage;
    const inbox = yield* Inbox;
    const journal = yield* Journal;
    const metrics = yield* OperatorMetrics;
    const schedules = yield* Schedules;
    const traces = yield* TurnTraces;
    const brief = yield* activeBriefScheduleId({ schedules, journal });
    const result = Option.isSome(brief) ? "folded" : "skipped";

    yield* database.transaction(() =>
      Effect.gen(function* foldEffect() {
        const recorded = yield* traces.readForEvent(event.eventId);
        const alreadyEnded = recorded.some(
          ({ trace }) => trace.task === "proactive_fold"
        );
        if (alreadyEnded) {
          return;
        }
        yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
        const record = {
          eventId: event.eventId,
          scheduleId: event.scheduleId,
          openLoopIds,
          reason,
        };
        yield* journal.append(
          result === "folded"
            ? { _tag: "ProactiveMessageFolded", ...record }
            : { _tag: "ProactiveMessageSkipped", ...record }
        );
        yield* traces.record({
          eventId: event.eventId,
          task: "proactive_fold",
          result: `proactive_message_${result}`,
          scheduleId: event.scheduleId,
          dueAt: event.dueAt,
          openLoopIds,
          reason,
          ...(budget === undefined ? {} : { budget }),
          ...(used === undefined ? {} : { used }),
        });
      })
    );
    yield* metrics.record({
      kind: "proactive_message",
      ownerId,
      eventId: event.eventId,
      result,
      latencyMillis: 0,
    });
    yield* inbox.markDone([event]);
  }
);
