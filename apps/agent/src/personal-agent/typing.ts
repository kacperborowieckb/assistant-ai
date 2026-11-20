import { Effect } from "effect";

import { Channel } from "../channels/channel.ts";
import { Redactor } from "../tracing/redactor.ts";
import type { OwnerMessageEvent } from "./inbox.ts";

const showTypingOnce = (conversationId: string) =>
  Effect.gen(function* showTypingOnceEffect() {
    const channel = yield* Channel;
    const redactor = yield* Redactor;
    yield* channel
      .showTyping(conversationId)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "The typing signal was not shown",
            redactor.redact(error.reason)
          )
        )
      );
  });

const keepTyping = (conversationId: string, repeatMillis: number) =>
  showTypingOnce(conversationId).pipe(
    Effect.andThen(Effect.sleep(repeatMillis)),
    Effect.forever
  );

/**
 * Shows "typing" in the Owner's chat while the effect runs: at once, then
 * every `repeatMillis`, until the effect ends. Typing is best-effort: a failed
 * signal is logged, and it never fails or delays the effect.
 */
export const whileTyping =
  (event: OwnerMessageEvent, repeatMillis: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* whileTypingEffect() {
        yield* Effect.forkScoped(
          keepTyping(event.conversationId, repeatMillis),
          { startImmediately: true }
        );
        return yield* effect;
      })
    );
