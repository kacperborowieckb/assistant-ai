import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalEntry, JournalRecord } from "../journal/journal.ts";
import { Conversation } from "./conversation.ts";
import { eventMessage } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { recordTurnFailed, sendHonestFailure } from "./turn-delivery.ts";
import { TurnProgress } from "./turn-progress.ts";

const tagsOf = (entries: readonly JournalEntry[]) =>
  new Set(entries.map((entry) => entry.record._tag));

const recordConversation = (
  event: InboxEvent,
  entries: readonly JournalEntry[]
) =>
  Effect.gen(function* recordConversationEffect() {
    const conversation = yield* Conversation;
    const progress = yield* TurnProgress;
    const earlier = yield* progress.completedFor(event.eventId);
    const tags = tagsOf(entries);
    const planned = entries.findLast(
      (entry) => entry.record._tag === "ReplyPlanned"
    );
    const reply =
      tags.has("ReplySent") &&
      !tags.has("TurnFailed") &&
      planned?.record._tag === "ReplyPlanned"
        ? [{ role: "assistant", content: planned.record.text } as const]
        : [];

    if (earlier.length + reply.length > 0) {
      yield* conversation.append(event.eventId, [
        eventMessage(event),
        ...earlier,
        ...reply,
      ]);
    }
  });

export const unconfirmedSendReason =
  "A send started but Telegram did not confirm it, so the agent did not send again";

const settleEntries = (event: InboxEvent, entries: readonly JournalEntry[]) =>
  Effect.gen(function* settleEntriesEffect() {
    const inbox = yield* Inbox;
    const journal = yield* Journal;
    const tags = tagsOf(entries);

    if (tags.has("TurnFailed")) {
      if (!tags.has("SendStarted")) {
        yield* sendHonestFailure(event);
        return "settled" as const;
      }
      if (!tags.has("ReplySent") && !tags.has("ReplyFailed")) {
        yield* journal.append({
          _tag: "ReplyFailed",
          eventId: event.eventId,
          reason: unconfirmedSendReason,
        });
      }
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    if (tags.has("ReplySent")) {
      yield* inbox.markDone([event]);
      return "settled" as const;
    }
    const failedSend = entries.find(
      (entry) => entry.record._tag === "ReplyFailed"
    );
    if (failedSend?.record._tag === "ReplyFailed") {
      yield* recordTurnFailed(event, failedSend.record.reason);
      return "settled" as const;
    }
    if (tags.has("SendStarted")) {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: unconfirmedSendReason,
      });
      yield* recordTurnFailed(event, unconfirmedSendReason);
      return "settled" as const;
    }
    return "unanswered" as const;
  });

const settlingTags: readonly JournalRecord["_tag"][] = [
  "TurnFailed",
  "ReplySent",
  "ReplyFailed",
  "SendStarted",
];

export const settleFromJournal = (event: InboxEvent) =>
  Effect.gen(function* settleFromJournalEffect() {
    const journal = yield* Journal;
    const entries = yield* journal.readForEvent(event.eventId);
    const tags = tagsOf(entries);

    if (settlingTags.some((tag) => tags.has(tag))) {
      yield* recordConversation(event, entries);
    }
    return yield* settleEntries(event, entries);
  });
