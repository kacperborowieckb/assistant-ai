import { Clock, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { lateReminderText } from "../schedule/late-reminder.ts";
import type { SendText } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";
import {
  fail,
  recordOutcome,
  send,
  unconfirmedSendReason,
} from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import { eventMessage } from "./event-message.ts";
import { lateNoticeFor } from "./fired-schedule-lateness.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";

interface ReminderRecord {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly text: string;
  readonly late: boolean;
  readonly latencyMillis: number;
}

type ReminderResult =
  | { readonly _tag: "Delivered"; readonly channelMessageId: string }
  | { readonly _tag: "Failed"; readonly reason: string };

const recordReminderOutcome = (
  { ownerId, event, text, late, latencyMillis }: ReminderRecord,
  result: ReminderResult
) =>
  recordOutcome({
    trace: {
      eventId: event.eventId,
      task: "reminder_delivery",
      result:
        result._tag === "Delivered"
          ? "reminder_delivered"
          : "reminder_delivery_failed",
      scheduleId: event.scheduleId,
      dueAt: event.dueAt,
      late,
      text,
      channelMessageId:
        result._tag === "Delivered" ? result.channelMessageId : null,
      error: result._tag === "Delivered" ? null : result.reason,
      latencyMillis,
    },
    metric: {
      kind: "reminder",
      ownerId,
      eventId: event.eventId,
      result: result._tag === "Delivered" ? "delivered" : "delivery_failed",
      latencyMillis,
    },
  });

const reminderResultOf = (state: DeliveryState): ReminderResult | undefined => {
  switch (state._tag) {
    case "Sent": {
      return { _tag: "Delivered", channelMessageId: state.channelMessageId };
    }
    case "SendFailed":
    case "SendFailureRecorded": {
      return { _tag: "Failed", reason: state.reason };
    }
    case "Unconfirmed": {
      return { _tag: "Failed", reason: unconfirmedSendReason };
    }
    default: {
      return undefined;
    }
  }
};

export const recoverReminderOutcome = Effect.fnUntraced(
  function* recoverReminderOutcome(
    ownerId: OwnerId,
    event: ScheduleFiredEvent,
    state: DeliveryState
  ) {
    const journal = yield* Journal;
    const result = reminderResultOf(state);
    const text = "text" in state ? state.text : undefined;
    if (result === undefined || text === undefined) {
      return;
    }
    const entries = yield* journal.readForEvent(event.eventId);
    yield* recordReminderOutcome(
      {
        ownerId,
        event,
        text,
        late: entries.some((entry) => entry.record._tag === "ReminderLate"),
        latencyMillis: 0,
      },
      result
    );
  }
);

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
  const delivery = yield* send(event, text);
  const record = {
    ownerId,
    event,
    text,
    late,
    latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
  };

  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  if (delivery._tag === "Failed") {
    yield* recordReminderOutcome(record, delivery);
    yield* fail(event, delivery.reason);
    return;
  }
  yield* recordReminderOutcome(record, {
    _tag: "Delivered",
    channelMessageId: delivery.channelMessageId,
  });
  yield* conversation.append(event.eventId, [
    eventMessage(event),
    { role: "assistant", content: text },
  ]);
  yield* inbox.markDone([event]);
});
