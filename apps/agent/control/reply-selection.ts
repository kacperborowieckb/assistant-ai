import { Duration, Effect, Option } from "effect";

import type { FakeTelegramMessage } from "./local-fakes.ts";

export interface ReplySelection {
  readonly replyParts: readonly FakeTelegramMessage[];
  readonly unprompted: readonly FakeTelegramMessage[];
}

export type TakeTelegramMessage = (
  timeout: Duration.Input
) => Effect.Effect<Option.Option<FakeTelegramMessage>>;

export const selectReplyTo = Effect.fnUntraced(function* selectReplyTo({
  inputMessageId,
  take,
  firstReplyTimeout,
  nextPartTimeout,
  stayedSilent = Effect.succeed(false),
}: {
  readonly inputMessageId: number;
  readonly take: TakeTelegramMessage;
  readonly firstReplyTimeout: Duration.Input;
  readonly nextPartTimeout: Duration.Input;
  readonly stayedSilent?: Effect.Effect<boolean>;
}) {
  const replyParts: FakeTelegramMessage[] = [];
  const unprompted: FakeTelegramMessage[] = [];
  const firstReplyMillis = Duration.toMillis(firstReplyTimeout);
  const chunkMillis = Duration.toMillis(nextPartTimeout);
  let waitedMillis = 0;
  for (;;) {
    const waitingForFirst = replyParts.length === 0;
    const silentBefore = waitingForFirst && (yield* stayedSilent);
    const timeout = waitingForFirst
      ? Math.min(chunkMillis, firstReplyMillis - waitedMillis)
      : chunkMillis;
    const next = yield* take(Duration.millis(timeout));
    if (Option.isNone(next)) {
      waitedMillis += timeout;
      if (waitingForFirst && !silentBefore && waitedMillis < firstReplyMillis) {
        continue;
      }
      return { replyParts, unprompted } satisfies ReplySelection;
    }
    if (next.value.replyToMessageId === inputMessageId) {
      replyParts.push(next.value);
    } else {
      unprompted.push(next.value);
    }
  }
});
