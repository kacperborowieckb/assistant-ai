import { Effect } from "effect";

import type { Delivery } from "../channels/channel.ts";
import { Journal } from "../journal/journal.ts";
import { Redactor } from "../tracing/redactor.ts";
import type { InboxEvent } from "./inbox.ts";

export const recordSend = Effect.fnUntraced(function* recordSend<Requirements>(
  event: InboxEvent,
  attempt: Effect.Effect<Delivery, never, Requirements>
) {
  const journal = yield* Journal;
  const redactor = yield* Redactor;

  yield* journal.append({ _tag: "SendStarted", eventId: event.eventId });
  const delivery = yield* attempt;

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
