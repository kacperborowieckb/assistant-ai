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

interface DeliveryRecord {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly text: string;
  readonly latencyMillis: number;
}

const recordDelivered = Effect.fnUntraced(function* recordDelivered(
  { ownerId, event, text, latencyMillis }: DeliveryRecord,
  channelMessageId: string
) {
  const traces = yield* TurnTraces;
  const metrics = yield* OperatorMetrics;
  yield* traces.record({
    eventId: event.eventId,
    task: "reminder_delivery",
    result: "reminder_delivered",
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
    text,
    channelMessageId,
    error: null,
    latencyMillis,
  });
  yield* metrics.record({
    kind: "reminder",
    ownerId,
    result: "delivered",
    latencyMillis,
  });
});

const recordDeliveryFailed = Effect.fnUntraced(function* recordDeliveryFailed(
  { ownerId, event, text, latencyMillis }: DeliveryRecord,
  reason: string
) {
  const traces = yield* TurnTraces;
  const metrics = yield* OperatorMetrics;
  yield* recordTurnFailed(event, reason);
  yield* traces.record({
    eventId: event.eventId,
    task: "reminder_delivery",
    result: "reminder_delivery_failed",
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
    text,
    channelMessageId: null,
    error: reason,
    latencyMillis,
  });
  yield* metrics.record({
    kind: "reminder",
    ownerId,
    result: "delivery_failed",
    latencyMillis,
  });
});

export const recoverDeliveredReminder = Effect.fnUntraced(
  function* recoverDeliveredReminder(
    ownerId: OwnerId,
    event: ScheduleFiredEvent
  ) {
    const journal = yield* Journal;
    const schedules = yield* Schedules;
    const traces = yield* TurnTraces;
    const entries = yield* journal.readForEvent(event.eventId);
    const planned = entries.findLast(
      (entry) => entry.record._tag === "ReplyPlanned"
    );
    const sent = entries.findLast((entry) => entry.record._tag === "ReplySent");
    const failed = entries.some((entry) => entry.record._tag === "TurnFailed");
    if (
      failed ||
      planned?.record._tag !== "ReplyPlanned" ||
      sent?.record._tag !== "ReplySent"
    ) {
      return;
    }
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    const recorded = yield* traces.read;
    if (!recorded.some(({ trace }) => trace.eventId === event.eventId)) {
      yield* recordDelivered(
        {
          ownerId,
          event,
          text: planned.record.text,
          latencyMillis: 0,
        },
        sent.record.channelMessageId
      );
    }
  }
);

export const deliverReminder = Effect.fnUntraced(function* deliverReminder(
  ownerId: OwnerId,
  event: ScheduleFiredEvent
) {
  const inbox = yield* Inbox;
  const schedules = yield* Schedules;
  const conversation = yield* Conversation;
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
  const record = {
    ownerId,
    event,
    text,
    latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
  };

  if (delivery._tag === "Failed") {
    yield* recordDeliveryFailed(record, delivery.reason);
    return;
  }
  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  yield* recordDelivered(record, delivery.channelMessageId);
  yield* conversation.append(event.eventId, [
    eventMessage(event),
    { role: "assistant", content: text },
  ]);
  yield* inbox.markDone([event]);
});
