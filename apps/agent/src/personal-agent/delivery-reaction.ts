import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { recordSend } from "./delivery-send.ts";
import type { InboxEvent } from "./inbox.ts";

export const noReactionTargetReason =
  "The Turn has no Owner message to react to";

export const sendReaction = Effect.fnUntraced(function* sendReaction(
  event: InboxEvent,
  emoji: string,
  replyTo: InboxEvent = event
) {
  const journal = yield* Journal;
  const channel = yield* Channel;

  if (replyTo._tag !== "OwnerMessage") {
    yield* journal.append({
      _tag: "ReplyFailed",
      eventId: event.eventId,
      reason: noReactionTargetReason,
    });
    return { _tag: "Failed", reason: noReactionTargetReason } as const;
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
  return yield* sendReaction(event, emoji, replyTo);
});
