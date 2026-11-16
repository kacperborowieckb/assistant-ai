import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { Redactor } from "../tracing/redactor.ts";
import { Conversation } from "./conversation.ts";
import { toolMessagesOf } from "./turn-record.ts";
import type { ModelOutcome } from "./turn-record.ts";

interface CompletedSteps {
  readonly eventId: string;
  readonly input: ModelMessage;
  readonly earlier: readonly ModelMessage[];
  readonly outcome: ModelOutcome;
}

export const rememberCompletedSteps = Effect.fnUntraced(
  function* rememberCompletedSteps({
    eventId,
    input,
    earlier,
    outcome,
  }: CompletedSteps) {
    const conversation = yield* Conversation;
    const redactor = yield* Redactor;
    const completed = toolMessagesOf(outcome);

    if (earlier.length + completed.length > 0) {
      yield* conversation.append(eventId, [
        input,
        ...earlier,
        ...completed.map((message) => redactor.redactMessage(message)),
      ]);
    }
  }
);
