import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import type {
  OutgoingReaction,
  ReactionDelivery,
} from "../channels/channel.ts";
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
  reaction: OutgoingReaction
) {
  const channel = yield* Channel;
  return yield* recordSend(event, channel.react(reaction));
});

const settledReaction = (event: InboxEvent, delivery: ReactionDelivery) =>
  delivery._tag === "Unconfirmed"
    ? recordReactionFailure(event, delivery.reason)
    : Effect.succeed(delivery);

export const sendReaction = Effect.fnUntraced(function* sendReaction(
  event: InboxEvent,
  reaction: OutgoingReaction
) {
  const delivery = yield* attemptReaction(event, reaction);
  return yield* settledReaction(event, delivery);
});

export const react = Effect.fnUntraced(function* react(
  event: InboxEvent,
  emoji: string,
  replyTo: InboxEvent = event
) {
  const journal = yield* Journal;

  if (replyTo._tag !== "OwnerMessage") {
    return yield* recordReactionFailure(event, noReactionTargetReason);
  }
  const reaction = {
    conversationId: replyTo.conversationId,
    channelMessageId: replyTo.channelMessageId,
    emoji,
  };
  yield* journal.append({
    _tag: "ReactionPlanned",
    eventId: event.eventId,
    ...reaction,
  });
  const first = yield* attemptReaction(event, reaction);
  const delivery =
    first._tag === "Unconfirmed"
      ? yield* attemptReaction(event, reaction)
      : first;
  return yield* settledReaction(event, delivery);
});
