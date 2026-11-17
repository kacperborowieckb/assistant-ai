import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";

export const honestFailureText =
  "Sorry, I could not answer that. Please try again in a moment.";

export const noOwnerConversationReason =
  "The Owner has no Channel conversation to send to yet";

const destinationOf = Effect.fnUntraced(function* destinationOf(
  event: InboxEvent
) {
  if (event._tag === "OwnerMessage") {
    return {
      conversationId: event.conversationId,
      inReplyTo: event.channelMessageId,
    };
  }
  const ownerConversation = yield* OwnerChannelConversation;
  const current = yield* ownerConversation.current;
  return current === undefined
    ? undefined
    : { conversationId: current.conversationId };
});

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
    const destination = yield* destinationOf(event);
    if (destination === undefined) {
      yield* journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: noOwnerConversationReason,
      });
      return { _tag: "Failed", reason: noOwnerConversationReason } as const;
    }
    yield* journal.append({ _tag: "SendStarted", eventId: event.eventId });
    const delivery = yield* channel.send({ ...destination, text });

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

export const sendHonestFailure = (
  event: InboxEvent,
  text: string = honestFailureText
) =>
  Effect.gen(function* sendHonestFailureEffect() {
    const inbox = yield* Inbox;
    const conversation = yield* Conversation;

    const delivery = yield* deliver(event, text);
    if (event._tag === "ScheduleFired" && delivery._tag !== "Failed") {
      yield* conversation.append(`${event.eventId}:failure-notice`, [
        { role: "assistant", content: text },
      ]);
    }
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
