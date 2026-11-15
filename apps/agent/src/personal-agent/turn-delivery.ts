import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";

export const honestFailureText =
  "Sorry, I could not answer that. Please try again in a moment.";

export const deliver = (event: InboxEvent, text: string) =>
  Effect.gen(function* deliverEffect() {
    const journal = yield* Journal;
    const channel = yield* Channel;
    const redactor = yield* Redactor;

    yield* journal.append({
      _tag: "ReplyPlanned",
      eventId: event.eventId,
      text,
    });
    yield* journal.append({ _tag: "SendStarted", eventId: event.eventId });
    const delivery = yield* channel.send({
      conversationId: event.conversationId,
      inReplyTo: event.channelMessageId,
      text,
    });

    if (delivery._tag === "Failed") {
      const reason = redactor.redact(delivery.reason);
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason,
      });
      return { _tag: "Failed", reason } as const;
    }
    yield* journal.append({
      _tag: "ReplySent",
      eventId: event.eventId,
      channelMessageId: delivery.channelMessageId,
    });
    return delivery;
  });

export const recordTurnFailed = (event: InboxEvent, reason: string) =>
  Effect.gen(function* recordTurnFailedEffect() {
    const inbox = yield* Inbox;
    const journal = yield* Journal;

    yield* journal.append({
      _tag: "TurnFailed",
      eventId: event.eventId,
      reason,
    });
    yield* inbox.markFailed([event]);
  });

export const sendHonestFailure = (event: InboxEvent) =>
  Effect.gen(function* sendHonestFailureEffect() {
    const inbox = yield* Inbox;

    yield* deliver(event, honestFailureText);
    yield* inbox.markFailed([event]);
  });

export const failTurnWithHonestMessage = (event: InboxEvent, reason: string) =>
  Effect.gen(function* failTurnWithHonestMessageEffect() {
    const journal = yield* Journal;

    yield* journal.append({
      _tag: "TurnFailed",
      eventId: event.eventId,
      reason,
    });
    yield* sendHonestFailure(event);
  });
