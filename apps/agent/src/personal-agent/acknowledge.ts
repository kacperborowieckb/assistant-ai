import { Effect, Fiber, Schedule } from "effect";

import { Channel } from "../channels/channel.ts";
import { Redactor } from "../tracing/redactor.ts";

const showTypingOnce = Effect.fnUntraced(function* showTypingOnce(
  conversationId: string
) {
  const channel = yield* Channel;
  const redactor = yield* Redactor;
  yield* channel
    .showTyping(conversationId)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "The Acknowledge typing signal was not shown",
          redactor.redact(error.reason)
        )
      )
    );
});

/**
 * Acknowledge: shows "typing" in the Owner's conversation at once and then
 * every `repeatMillis`, until `stop` runs or the scope closes. It is
 * best-effort: a failed signal is logged and never fails or delays the Turn.
 */
export const startAcknowledging = Effect.fnUntraced(
  function* startAcknowledging(conversationId: string, repeatMillis: number) {
    const typing = yield* Effect.forkScoped(
      showTypingOnce(conversationId).pipe(
        Effect.repeat(Schedule.spaced(repeatMillis))
      ),
      { startImmediately: true }
    );
    return { stop: Fiber.interrupt(typing) };
  }
);
