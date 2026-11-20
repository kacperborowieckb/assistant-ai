import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import type { ReactionDelivery } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import { recordSend } from "./delivery-send.ts";
import type { InboxEvent } from "./inbox.ts";

export const noReactionTargetReason =
  "The Turn has no Owner message to react to";

const recordReactionFailure = Effect.fnUntraced(function* recordReactionFailure(
  event: InboxEvent,
  reason: string
) {
  const journal = yield* Journal;
  const redactor = yield* Redactor;
  const redacted = redactor.redact(reason);

  yield* journal.append({
    _tag: "ReplyFailed",
    eventId: event.eventId,
    reason: redacted,
  });
  return { _tag: "Failed", reason: redacted } as const;
});

const attemptReaction = Effect.fnUntraced(function* attemptReaction(
  event: InboxEvent,
  emoji: string,
  replyTo: InboxEvent
) {
  const channel = yield* Channel;

  if (replyTo._tag !== "OwnerMessage") {
    return yield* recordReactionFailure(event, noReactionTargetReason);
  }
  return yield* recordSend(
    event,
    channel.react({
      conversationId: replyTo.conversationId,
      channelMessageId: replyTo.channelMessageId,
      emoji,
    })
  );
});

const settledReaction = (event: InboxEvent, delivery: ReactionDelivery) =>
  delivery._tag === "Unconfirmed"
    ? recordReactionFailure(event, delivery.reason)
    : Effect.succeed(delivery);

export const sendReaction = Effect.fnUntraced(function* sendReaction(
  event: InboxEvent,
  emoji: string,
  replyTo: InboxEvent = event
) {
  const delivery = yield* attemptReaction(event, emoji, replyTo);
  return yield* settledReaction(event, delivery);
});

export const react = Effect.fnUntraced(function* react(
  event: InboxEvent,
  emoji: string,
  replyTo: InboxEvent = event
) {
  const journal = yield* Journal;

  yield* journal.append({
    _tag: "ReactionPlanned",
    eventId: event.eventId,
    emoji,
  });
  const first = yield* attemptReaction(event, emoji, replyTo);
  const delivery =
    first._tag === "Unconfirmed"
      ? yield* attemptReaction(event, emoji, replyTo)
      : first;
  return yield* settledReaction(event, delivery);
});
