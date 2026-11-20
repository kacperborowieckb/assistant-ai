import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalEntry } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";
import {
  deliveryStateOfEntries,
  fail,
  honestFailureText,
  recordUnconfirmedSend,
  rememberFailureNotice,
  sendFailureNotice,
  unconfirmedSendReason,
} from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import { inputMessageOf } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
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

interface SkippedScheduledTask {
  readonly dailyTokenBudget: number;
  readonly tokensSpent: number;
}

export interface Recovery<UnsentRequirements, NoticeRequirements> {
  readonly resumeUnsent: (
    skipped: SkippedScheduledTask | undefined
  ) => Effect.Effect<"settled" | "unanswered", unknown, UnsentRequirements>;
  readonly failureNoticeText: Effect.Effect<
    string | undefined,
    unknown,
    NoticeRequirements
  >;
}

export const ownerMessageRecovery = {
  resumeUnsent: () => Effect.succeed("unanswered" as const),
  failureNoticeText: Effect.succeed(honestFailureText),
};

interface Settling<UnsentRequirements, NoticeRequirements> {
  readonly event: InboxEvent;
  readonly entries: readonly JournalEntry[];
  readonly state: DeliveryState;
  readonly recovery: Recovery<UnsentRequirements, NoticeRequirements>;
}

const skippedPointOf = (entries: readonly JournalEntry[]) => {
  const skipped = entries.find(
    (entry) => entry.record._tag === "ScheduledTaskSkipped"
  );
  return skipped?.record._tag === "ScheduledTaskSkipped"
    ? skipped.record
    : undefined;
};

const settleState = Effect.fnUntraced(function* settleState<
  UnsentRequirements,
  NoticeRequirements,
>({
  event,
  entries,
  state,
  recovery,
}: Settling<UnsentRequirements, NoticeRequirements>) {
  const inbox = yield* Inbox;

  switch (state._tag) {
    case "Unsent": {
      return yield* recovery.resumeUnsent(skippedPointOf(entries));
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
      const noticeText = yield* recovery.failureNoticeText;
      yield* noticeText === undefined
        ? inbox.markFailed([event])
        : sendFailureNotice(event, noticeText);
      return "settled" as const;
    }
    case "FailedNoticeSent": {
      yield* rememberFailureNotice(event, state.text);
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    case "SendFailureRecorded":
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

export const settleFromJournal = Effect.fnUntraced(function* settleFromJournal<
  UnsentRequirements,
  NoticeRequirements,
>(
  event: InboxEvent,
  recovery: Recovery<UnsentRequirements, NoticeRequirements>
) {
  const journal = yield* Journal;
  const entries = yield* journal.readForEvent(event.eventId);
  const state = deliveryStateOfEntries(entries);

  if (state._tag !== "Unsent") {
    yield* recordConversation(event, state);
  }
  return yield* settleState({ event, entries, state, recovery });
});
