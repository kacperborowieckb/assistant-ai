import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import { Schedules } from "../schedule/schedules.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import type { proactiveFoldReasons } from "./storage-values.ts";

interface ProactiveFold {
  readonly event: ScheduleFiredEvent;
  readonly openLoopIds: readonly string[];
  readonly reason: (typeof proactiveFoldReasons)[number];
}

export const foldProactiveMessage = Effect.fnUntraced(
  function* foldProactiveMessage({
    event,
    openLoopIds,
    reason,
  }: ProactiveFold) {
    const { database } = yield* AgentStorage;
    const inbox = yield* Inbox;
    const journal = yield* Journal;
    const schedules = yield* Schedules;
    const traces = yield* TurnTraces;

    yield* database.transaction(() =>
      Effect.gen(function* foldEffect() {
        const recorded = yield* traces.readForEvent(event.eventId);
        const alreadyFolded = recorded.some(
          ({ trace }) => trace.task === "proactive_fold"
        );
        if (alreadyFolded) {
          return;
        }
        yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
        yield* journal.append({
          _tag: "ProactiveMessageFolded",
          eventId: event.eventId,
          scheduleId: event.scheduleId,
          openLoopIds,
          reason,
        });
        yield* traces.record({
          eventId: event.eventId,
          task: "proactive_fold",
          result: "proactive_message_folded",
          scheduleId: event.scheduleId,
          dueAt: event.dueAt,
          openLoopIds,
          reason,
        });
      })
    );
    yield* inbox.markDone([event]);
  }
);
