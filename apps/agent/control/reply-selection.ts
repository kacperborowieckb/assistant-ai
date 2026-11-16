import { Effect, Option } from "effect";
import type { Duration } from "effect";

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
}: {
  readonly inputMessageId: number;
  readonly take: TakeTelegramMessage;
  readonly firstReplyTimeout: Duration.Input;
  readonly nextPartTimeout: Duration.Input;
}) {
  const replyParts: FakeTelegramMessage[] = [];
  const unprompted: FakeTelegramMessage[] = [];
  for (;;) {
    const next = yield* take(
      replyParts.length === 0 ? firstReplyTimeout : nextPartTimeout
    );
    if (Option.isNone(next)) {
      return { replyParts, unprompted } satisfies ReplySelection;
    }
    if (next.value.replyToMessageId === inputMessageId) {
      replyParts.push(next.value);
    } else {
      unprompted.push(next.value);
    }
  }
});
