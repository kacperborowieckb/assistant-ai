import { Effect, Schedule } from "effect";

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
 * Acknowledge: shows "typing" in the Owner's conversation while the effect
 * runs, at once and then every `repeatMillis`, until the effect ends. It is
 * best-effort: a failed signal is logged and never fails or delays the effect.
 */
export const whileAcknowledging =
  (conversationId: string, repeatMillis: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* whileAcknowledgingEffect() {
        yield* Effect.forkScoped(
          showTypingOnce(conversationId).pipe(
            Effect.repeat(Schedule.spaced(repeatMillis))
          ),
          { startImmediately: true }
        );
        return yield* effect;
      })
    );
