import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import type { JournalEntry } from "../journal/journal.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";

export const honestFailureText =
  "Sorry, I could not answer that. Please try again in a moment.";

export const noOwnerConversationReason =
  "The Owner has no Channel conversation to send to yet";

export const unconfirmedSendReason =
  "A send started but Telegram did not confirm it, so the agent did not send again";

export type DeliveryState =
  | { readonly _tag: "Unsent" }
  | {
      readonly _tag: "Sent";
      readonly text: string | undefined;
      readonly channelMessageId: string;
    }
  | {
      readonly _tag: "SendFailed";
      readonly text: string | undefined;
      readonly reason: string;
    }
  | { readonly _tag: "Unconfirmed"; readonly text: string | undefined }
  | { readonly _tag: "FailedNoticePending" }
  | { readonly _tag: "FailedNoticeSent"; readonly text: string }
  | {
      readonly _tag: "FailedNoticeRefused";
      readonly text: string | undefined;
      readonly reason: string;
    }
  | {
      readonly _tag: "FailedNoticeUnconfirmed";
      readonly text: string | undefined;
    };

const lastOf = <Tag extends JournalEntry["record"]["_tag"]>(
  entries: readonly JournalEntry[],
  tag: Tag
) => {
  const found = entries.findLast((entry) => entry.record._tag === tag);
  return found?.record as
    | Extract<JournalEntry["record"], { _tag: Tag }>
    | undefined;
};

export const deliveryStateOfEntries = (
  entries: readonly JournalEntry[]
): DeliveryState => {
  const tags = new Set(entries.map((entry) => entry.record._tag));
  const planned = lastOf(entries, "ReplyPlanned");
  const sent = lastOf(entries, "ReplySent");
  const sendFailed = lastOf(entries, "ReplyFailed");
  const turnFailed = lastOf(entries, "TurnFailed");

  if (turnFailed !== undefined) {
    if (!tags.has("SendStarted") && sendFailed === undefined) {
      return { _tag: "FailedNoticePending" };
    }
    if (sent !== undefined && planned !== undefined) {
      return { _tag: "FailedNoticeSent", text: planned.text };
    }
    if (sendFailed !== undefined) {
      return {
        _tag: "FailedNoticeRefused",
        text: planned?.text,
        reason: turnFailed.reason,
      };
    }
    return { _tag: "FailedNoticeUnconfirmed", text: planned?.text };
  }
  if (sent !== undefined) {
    return {
      _tag: "Sent",
      text: planned?.text,
      channelMessageId: sent.channelMessageId,
    };
  }
  if (sendFailed !== undefined) {
    return {
      _tag: "SendFailed",
      text: planned?.text,
      reason: sendFailed.reason,
    };
  }
  return tags.has("SendStarted")
    ? { _tag: "Unconfirmed", text: planned?.text }
    : { _tag: "Unsent" };
};

export const deliveryStateOf = (eventId: string) =>
  Journal.pipe(
    Effect.flatMap((journal) => journal.readForEvent(eventId)),
    Effect.map(deliveryStateOfEntries)
  );

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

export const send = Effect.fnUntraced(function* send(
  event: InboxEvent,
  text: string
) {
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

export const recordFailure = (event: InboxEvent, reason: string) =>
  Journal.pipe(
    Effect.flatMap((journal) =>
      journal.append({ _tag: "TurnFailed", eventId: event.eventId, reason })
    )
  );

export const fail = Effect.fnUntraced(function* fail(
  event: InboxEvent,
  reason: string
) {
  const inbox = yield* Inbox;

  yield* recordFailure(event, reason);
  yield* inbox.markFailed([event]);
});

export const rememberFailureNotice = (event: InboxEvent, text: string) =>
  Conversation.pipe(
    Effect.flatMap((conversation) =>
      event._tag === "ScheduleFired"
        ? conversation.append(`${event.eventId}:failure-notice`, [
            { role: "assistant", content: text },
          ])
        : Effect.void
    )
  );

export const sendFailureNotice = Effect.fnUntraced(function* sendFailureNotice(
  event: InboxEvent,
  text: string = honestFailureText
) {
  const inbox = yield* Inbox;

  const delivery = yield* send(event, text);
  if (delivery._tag !== "Failed") {
    yield* rememberFailureNotice(event, text);
  }
  yield* inbox.markFailed([event]);
});

export const failWithNotice = Effect.fnUntraced(function* failWithNotice(
  event: InboxEvent,
  reason: string
) {
  yield* recordFailure(event, reason);
  yield* sendFailureNotice(event);
});

export const recordUnconfirmedSend = (event: InboxEvent) =>
  Journal.pipe(
    Effect.flatMap((journal) =>
      journal.append({
        _tag: "ReplyFailed",
        eventId: event.eventId,
        reason: unconfirmedSendReason,
      })
    )
  );

interface EventOutcome {
  readonly trace: TurnTrace;
  readonly metric: OperatorMetric;
}

export const recordOutcome = Effect.fnUntraced(function* recordOutcome({
  trace,
  metric,
}: EventOutcome) {
  const traces = yield* TurnTraces;
  const metrics = yield* OperatorMetrics;

  const recorded = yield* traces.readForEvent(trace.eventId);
  if (recorded.length > 0) {
    return;
  }
  yield* metrics.record(metric);
  yield* traces.record(trace);
});
