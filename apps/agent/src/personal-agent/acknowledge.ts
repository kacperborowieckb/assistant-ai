import { Effect, Fiber, Option, Schedule } from "effect";

import { Channel } from "../channels/channel.ts";
import { Redactor } from "../tracing/redactor.ts";

const showTypingOnce = Effect.fnUntraced(function* showTypingOnce(
  conversationId: string,
  timeoutMillis: number
) {
  const channel = yield* Channel;
  const redactor = yield* Redactor;
  const shown = yield* channel.showTyping(conversationId).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logWarning(
        "The Acknowledge typing signal was not shown",
        redactor.redact(error.reason)
      ).pipe(Effect.as(true))
    ),
    Effect.timeoutOption(timeoutMillis)
  );
  if (Option.isNone(shown)) {
    yield* Effect.logWarning(
      "The Acknowledge typing signal got no answer in time"
    );
  }
});

/**
 * Acknowledge: shows "typing" in the Owner's conversation while the effect
 * runs, at once and then every `repeatMillis` on a fixed cadence; an attempt
 * with no answer within `repeatMillis` is given up, so the next one still runs. Typing stops as soon as the
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
          showTypingOnce(conversationId, repeatMillis).pipe(
            Effect.repeat(Schedule.fixed(repeatMillis))
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
