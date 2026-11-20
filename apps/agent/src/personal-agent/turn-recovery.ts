import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalEntry } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import { burstInputs, newestEventOf } from "./burst.ts";
import type { Burst } from "./burst.ts";
import { Conversation } from "./conversation.ts";
import { sendReaction } from "./delivery-reaction.ts";
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
  state: DeliveryState,
  inputs: readonly ModelMessage[] | undefined
) {
  const conversation = yield* Conversation;
  const progress = yield* TurnProgress;
  const redactor = yield* Redactor;
  const earlier = yield* progress.completedFor(event.eventId);
  const reply =
    state._tag === "Sent" && state.text !== undefined
      ? [{ role: "assistant", content: state.text } as const]
      : [];

  const endedWithoutText =
    state._tag === "Silent" ||
    state._tag === "ReactionUnconfirmed" ||
    (state._tag === "Sent" && state.reaction !== undefined);
  if (endedWithoutText || earlier.length + reply.length > 0) {
    yield* conversation.append(event.eventId, [
      ...(inputs ?? [yield* inputMessageOf(event)]).map((input) =>
        redactor.redactMessage(input)
      ),
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
  readonly inputs?: readonly ModelMessage[];
  readonly replyTo?: InboxEvent;
}

export const ownerMessageRecovery = (burst: Burst) => ({
  resumeUnsent: () => Effect.succeed("unanswered" as const),
  failureNoticeText: Effect.succeed(honestFailureText),
  inputs: burstInputs(burst),
  replyTo: newestEventOf(burst),
});

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
    case "Sent":
    case "Silent": {
      yield* inbox.markDone([event]);
      return "settled" as const;
    }
    case "SendFailed": {
      yield* fail(event, state.reason);
      return "settled" as const;
    }
    case "ReactionUnconfirmed": {
      const delivery = yield* sendReaction(
        event,
        state.emoji,
        recovery.replyTo
      );
      yield* delivery._tag === "Failed"
        ? fail(event, delivery.reason)
        : inbox.markDone([event]);
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
        : sendFailureNotice(event, noticeText, recovery.replyTo);
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
    yield* recordConversation(event, state, recovery.inputs);
  }
  return yield* settleState({ event, entries, state, recovery });
});
