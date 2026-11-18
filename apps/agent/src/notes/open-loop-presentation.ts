import { DateTime, Effect, Option, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import {
  instantOfLocalDueTime,
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import { localTimeOf } from "../time/local-time.ts";
import type { OpenLoopToolServices } from "./open-loop-tool-services.ts";
import type { OpenLoop } from "./open-loop.ts";

export const openLoopLocalDueTimeSchema = LocalDueTimeSchema.pipe(
  Schema.annotate({
    description: `When the Open Loop is due, as the local date and time of the Owner in the form ${localDueTimeFormat} with no time zone or offset, for example 2026-11-20T18:00. Work it out from the current local time that you were given. Leave it out when the Owner gave no date.`,
  })
);

export const noTimeZoneForOpenLoopMessage = `The time zone of the Owner is not known, so the due date cannot be stored. Nothing was written. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then try again.`;

export const invalidOpenLoopDueMessage = `The due time is not a real local date and time in the form ${localDueTimeFormat}. Nothing was written. Check the date and try again.`;

export const openLoopForModel = (
  openLoop: OpenLoop | undefined,
  timeZone: Option.Option<DateTime.TimeZone.Named>
) =>
  openLoop === undefined
    ? null
    : {
        kind: openLoop.kind,
        state:
          openLoop._tag === "Open" ? ("open" as const) : ("closed" as const),
        closeReason: openLoop._tag === "Closed" ? openLoop.reason : null,
        dueAt:
          openLoop.dueAt === undefined
            ? null
            : DateTime.formatIso(openLoop.dueAt),
        due:
          openLoop.dueAt === undefined || Option.isNone(timeZone)
            ? null
            : localTimeOf(openLoop.dueAt, timeZone.value),
      };

export const resolveOpenLoopDue = Effect.fnUntraced(
  function* resolveOpenLoopDue(
    { ownerTimeZone }: Pick<OpenLoopToolServices, "ownerTimeZone">,
    localDueTime: string | undefined
  ) {
    if (localDueTime === undefined) {
      return;
    }
    const timeZone = yield* ownerTimeZone;
    if (Option.isNone(timeZone)) {
      return yield* new ToolFailed({ message: noTimeZoneForOpenLoopMessage });
    }
    const dueAt = instantOfLocalDueTime(localDueTime, timeZone.value);
    if (Option.isNone(dueAt)) {
      return yield* new ToolFailed({ message: invalidOpenLoopDueMessage });
    }
    return dueAt.value;
  }
);
