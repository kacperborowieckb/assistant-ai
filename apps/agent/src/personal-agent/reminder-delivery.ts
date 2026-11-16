import { Clock, DateTime, Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { Schedules } from "../schedule/schedules.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { eventMessage } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { deliver, recordTurnFailed } from "./turn-delivery.ts";

export const completeScheduleIfDelivered = (event: ScheduleFiredEvent) =>
  Effect.gen(function* completeScheduleIfDeliveredEffect() {
    const journal = yield* Journal;
    const schedules = yield* Schedules;
    const tags = new Set(
      (yield* journal.readForEvent(event.eventId)).map(
        (entry) => entry.record._tag
      )
    );
    if (tags.has("ReplySent") && !tags.has("TurnFailed")) {
      yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    }
  });

export const deliverReminder = (ownerId: OwnerId, event: ScheduleFiredEvent) =>
  Effect.gen(function* deliverReminderEffect() {
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;
    const conversation = yield* Conversation;
    const traces = yield* TurnTraces;
    const metrics = yield* OperatorMetrics;
    const redactor = yield* Redactor;
    const startedAt = yield* Clock.currentTimeMillis;

    const schedule = yield* schedules.byId(event.scheduleId);
    const stillDue =
      schedule._tag === "Some" &&
      schedule.value.state === "active" &&
      DateTime.formatIso(schedule.value.nextDueAt) === event.dueAt;
    if (!stillDue) {
      yield* inbox.markDone([event]);
      return;
    }
    const text = redactor.redact(schedule.value.text);
    const delivery = yield* deliver(event, text);
    const latencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    const traced = {
      eventId: event.eventId,
      task: "reminder_delivery",
      scheduleId: event.scheduleId,
      dueAt: event.dueAt,
      text,
      latencyMillis,
    } as const;

    if (delivery._tag === "Failed") {
      yield* recordTurnFailed(event, delivery.reason);
      yield* traces.record({
        ...traced,
        result: "reminder_delivery_failed",
        channelMessageId: null,
        error: delivery.reason,
      });
      yield* metrics.record({
        kind: "reminder",
        ownerId,
        result: "delivery_failed",
        latencyMillis,
      });
      return;
    }
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    yield* conversation.append(event.eventId, [
      eventMessage(event),
      { role: "assistant", content: text },
    ]);
    yield* inbox.markDone([event]);
    yield* traces.record({
      ...traced,
      result: "reminder_delivered",
      channelMessageId: delivery.channelMessageId,
      error: null,
    });
    yield* metrics.record({
      kind: "reminder",
      ownerId,
      result: "delivered",
      latencyMillis,
    });
  });
