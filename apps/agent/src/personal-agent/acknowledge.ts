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
 * Acknowledge: shows "typing" in the Owner's conversation while the effect
 * runs, at once and then every `repeatMillis`. Typing stops as soon as the
 * effect starts a Channel send (the reply or the honest failure notice), so
 * no signal follows the outcome, and the scope stops it as a backstop. It is
 * best-effort: a failed signal is logged and never fails or delays the effect.
 */
export const whileAcknowledging =
  (conversationId: string, repeatMillis: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* whileAcknowledgingEffect() {
        const channel = yield* Channel;
        const typing = yield* Effect.forkScoped(
          showTypingOnce(conversationId).pipe(
            Effect.repeat(Schedule.spaced(repeatMillis))
          ),
          { startImmediately: true }
        );
        return yield* effect.pipe(
          Effect.provideService(
            Channel,
            Channel.of({
              ...channel,
              send: (message) =>
                Fiber.interrupt(typing).pipe(
                  Effect.andThen(channel.send(message))
                ),
            })
          )
        );
      })
    );
