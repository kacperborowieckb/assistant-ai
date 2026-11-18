import { Clock, DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import type { JournalRecord } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import {
  isLate,
  lateByMillisOf,
  lateReminderText,
} from "../schedule/late-reminder.ts";
import type { SendText } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
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
  readonly late: boolean;
  readonly latencyMillis: number;
}

const recordDelivered = Effect.fnUntraced(function* recordDelivered(
  { ownerId, event, text, late, latencyMillis }: DeliveryRecord,
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
    late,
    text,
    channelMessageId,
    error: null,
    latencyMillis,
  });
  yield* metrics.record({
    kind: "reminder",
    ownerId,
    eventId: event.eventId,
    result: "delivered",
    latencyMillis,
  });
});

const recordFailedTrace = Effect.fnUntraced(function* recordFailedTrace(
  { event, text, late, latencyMillis }: DeliveryRecord,
  reason: string
) {
  const traces = yield* TurnTraces;
  yield* traces.record({
    eventId: event.eventId,
    task: "reminder_delivery",
    result: "reminder_delivery_failed",
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
    late,
    text,
    channelMessageId: null,
    error: reason,
    latencyMillis,
  });
});

const recordDeliveryFailed = Effect.fnUntraced(function* recordDeliveryFailed(
  record: DeliveryRecord,
  reason: string
) {
  const metrics = yield* OperatorMetrics;
  yield* recordFailedTrace(record, reason);
  yield* recordTurnFailed(record.event, reason);
  yield* metrics.record({
    kind: "reminder",
    ownerId: record.ownerId,
    eventId: record.event.eventId,
    result: "delivery_failed",
    latencyMillis: record.latencyMillis,
  });
});

type RecordedOutcome =
  | { readonly _tag: "Failed"; readonly reason: string }
  | { readonly _tag: "Delivered"; readonly channelMessageId: string };

const outcomeOf = (
  failure: JournalRecord | undefined,
  sent: JournalRecord | undefined
): RecordedOutcome | undefined => {
  if (
    failure?.["_tag"] === "ReplyFailed" ||
    failure?.["_tag"] === "TurnFailed"
  ) {
    return { _tag: "Failed", reason: failure.reason };
  }
  return sent?.["_tag"] === "ReplySent"
    ? { _tag: "Delivered", channelMessageId: sent.channelMessageId }
    : undefined;
};

export const recoverReminderRecord = Effect.fnUntraced(
  function* recoverReminderRecord(ownerId: OwnerId, event: ScheduleFiredEvent) {
    const journal = yield* Journal;
    const schedules = yield* Schedules;
    const traces = yield* TurnTraces;
    const entries = yield* journal.readForEvent(event.eventId);
    const planned = entries.findLast(
      (entry) => entry.record._tag === "ReplyPlanned"
    );
    const sent = entries.findLast((entry) => entry.record._tag === "ReplySent");
    const failure = entries.findLast(
      (entry) =>
        entry.record._tag === "ReplyFailed" ||
        entry.record._tag === "TurnFailed"
    );
    if (planned?.record._tag !== "ReplyPlanned") {
      return;
    }
    const record = {
      ownerId,
      event,
      text: planned.record.text,
      late: entries.some((entry) => entry.record._tag === "ReminderLate"),
      latencyMillis: 0,
    };
    const outcome = outcomeOf(failure?.record, sent?.record);
    if (outcome === undefined) {
      return;
    }
    if (outcome._tag === "Delivered") {
      yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    }
    const recorded = yield* traces.readForEvent(event.eventId);
    if (recorded.length > 0) {
      return;
    }
    yield* outcome._tag === "Delivered"
      ? recordDelivered(record, outcome.channelMessageId)
      : recordFailedTrace(record, outcome.reason);
  }
);

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

const reminderTextFor = Effect.fnUntraced(function* reminderTextFor(
  behavior: BehaviorConfig,
  event: ScheduleFiredEvent,
  savedText: string
) {
  const notice = yield* lateNoticeFor(behavior, event);
  return Option.isNone(notice)
    ? { text: savedText, late: false }
    : {
        text: lateReminderText(
          savedText,
          notice.value.dueAt,
          notice.value.timeZone
        ),
        late: true,
      };
});

interface ReminderDelivery {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly action: SendText;
}

export const deliverReminder = Effect.fnUntraced(function* deliverReminder({
  ownerId,
  behavior,
  event,
  action,
}: ReminderDelivery) {
  const inbox = yield* Inbox;
  const schedules = yield* Schedules;
  const conversation = yield* Conversation;
  const redactor = yield* Redactor;
  const startedAt = yield* Clock.currentTimeMillis;

  const { text, late } = yield* reminderTextFor(
    behavior,
    event,
    redactor.redact(action.text)
  );
  const delivery = yield* deliver(event, text);
  const record = {
    ownerId,
    event,
    text,
    late,
    latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
  };

  if (delivery._tag === "Failed") {
    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
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
