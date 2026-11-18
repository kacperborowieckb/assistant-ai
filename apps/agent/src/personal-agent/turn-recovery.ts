import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalEntry } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";
import {
  deliveryStateOfEntries,
  fail,
  recordUnconfirmedSend,
  rememberFailureNotice,
  sendFailureNotice,
  unconfirmedSendReason,
} from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import { inputMessageOf } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { honestFailureTextOf } from "./scheduled-task-failure.ts";
import { resumeSkippedScheduledTask } from "./scheduled-task-skip.ts";
import { TurnProgress } from "./turn-progress.ts";

const recordConversation = Effect.fnUntraced(function* recordConversation(
  event: InboxEvent,
  state: DeliveryState
) {
  const conversation = yield* Conversation;
  const progress = yield* TurnProgress;
  const redactor = yield* Redactor;
  const earlier = yield* progress.completedFor(event.eventId);
  const reply =
    state._tag === "Sent" && state.text !== undefined
      ? [{ role: "assistant", content: state.text } as const]
      : [];

  if (earlier.length + reply.length > 0) {
    yield* conversation.append(event.eventId, [
      redactor.redactMessage(yield* inputMessageOf(event)),
      ...earlier,
      ...reply,
    ]);
  }
});

const settleUnsent = Effect.fnUntraced(function* settleUnsent(
  ownerId: OwnerId,
  event: InboxEvent,
  entries: readonly JournalEntry[]
) {
  const skipped = entries.find(
    (entry) => entry.record._tag === "ScheduledTaskSkipped"
  );
  if (
    event._tag === "ScheduleFired" &&
    skipped?.record._tag === "ScheduledTaskSkipped"
  ) {
    yield* resumeSkippedScheduledTask(ownerId, event, skipped.record);
    return "settled" as const;
  }
  return "unanswered" as const;
});

interface Settling {
  readonly ownerId: OwnerId;
  readonly event: InboxEvent;
  readonly entries: readonly JournalEntry[];
  readonly state: DeliveryState;
}

const settleState = Effect.fnUntraced(function* settleState({
  ownerId,
  event,
  entries,
  state,
}: Settling) {
  const inbox = yield* Inbox;

  switch (state._tag) {
    case "Unsent": {
      return yield* settleUnsent(ownerId, event, entries);
    }
    case "Sent": {
      yield* inbox.markDone([event]);
      return "settled" as const;
    }
    case "SendFailed": {
      yield* fail(event, state.reason);
      return "settled" as const;
    }
    case "Unconfirmed": {
      yield* recordUnconfirmedSend(event);
      yield* fail(event, unconfirmedSendReason);
      return "settled" as const;
    }
    case "FailedNoticePending": {
      yield* sendFailureNotice(event, yield* honestFailureTextOf(event));
      return "settled" as const;
    }
    case "FailedNoticeSent": {
      yield* rememberFailureNotice(event, state.text);
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    case "FailedNoticeRefused": {
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    case "FailedNoticeUnconfirmed": {
      yield* recordUnconfirmedSend(event);
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    default: {
      return state satisfies never;
    }
  }
});

export const settleFromJournal = Effect.fnUntraced(function* settleFromJournal(
  ownerId: OwnerId,
  event: InboxEvent
) {
  const journal = yield* Journal;
  const entries = yield* journal.readForEvent(event.eventId);
  const state = deliveryStateOfEntries(entries);

  if (state._tag !== "Unsent") {
    yield* recordConversation(event, state);
  }
  return yield* settleState({ ownerId, event, entries, state });
});
