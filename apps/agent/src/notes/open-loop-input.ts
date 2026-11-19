import { Effect, Option, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import {
  instantOfLocalDueTime,
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import type { OpenLoopRequest } from "./open-loop-change.ts";
import { OpenLoopKindSchema } from "./open-loop.ts";
import type { OwnerTimeZone } from "./recalled-note.ts";

export const OpenLoopInputSchema = Schema.Struct({
  kind: OpenLoopKindSchema.pipe(
    Schema.annotate({
      description:
        "What kind of thing it is to come back to, in one or two words, for example task, waiting, or project.",
    })
  ),
  localDueTime: Schema.optionalKey(
    LocalDueTimeSchema.pipe(
      Schema.annotate({
        description: `When it is due, as the local date and time of the Owner in the form ${localDueTimeFormat} with no time zone or offset, for example 2026-11-20T18:00. Work it out from the current local time that you were given. Leave it out when it has no due date.`,
      })
    )
  ),
}).pipe(
  Schema.annotate({
    description:
      "An Open Loop: give it when the Note is something to do or to come back to, such as a task. Give none for a fact.",
  })
);

export type OpenLoopInput = typeof OpenLoopInputSchema.Type;

export interface OpenLoopInputMessages {
  readonly toolName: string;
  readonly consequence: string;
}

export const noTimeZoneForOpenLoopMessage = ({
  toolName,
  consequence,
}: OpenLoopInputMessages) =>
  `The time zone of the Owner is not known, so the due time cannot be read. ${consequence} Call ${toolName} again without localDueTime, and ask the Owner for their time zone.`;

export const invalidOpenLoopDueTimeMessage = ({
  toolName,
  consequence,
}: OpenLoopInputMessages) =>
  `The due time is not a real local date and time in the form ${localDueTimeFormat}. ${consequence} Check the date and call ${toolName} again.`;

export const openLoopRequestOf = Effect.fnUntraced(function* openLoopRequestOf(
  input: OpenLoopInput | undefined,
  ownerTimeZone: Effect.Effect<OwnerTimeZone>,
  messages: OpenLoopInputMessages
) {
  if (input === undefined) {
    return;
  }
  const { kind, localDueTime } = input;
  if (localDueTime === undefined) {
    return { kind } satisfies OpenLoopRequest;
  }
  const timeZone = yield* ownerTimeZone;
  if (Option.isNone(timeZone)) {
    return yield* new ToolFailed({
      message: noTimeZoneForOpenLoopMessage(messages),
    });
  }
  const dueAt = instantOfLocalDueTime(localDueTime, timeZone.value);
  if (Option.isNone(dueAt)) {
    return yield* new ToolFailed({
      message: invalidOpenLoopDueTimeMessage(messages),
    });
  }
  return { kind, dueAt: dueAt.value } satisfies OpenLoopRequest;
});
