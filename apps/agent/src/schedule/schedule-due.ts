import { DateTime, Effect, Option } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { instantOfLocalDueTime } from "../time/local-due-time.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import type { Repeat } from "./schedule.ts";

export interface ScheduleDueRequest {
  readonly localDueTime?: string | undefined;
  readonly repeat?: RecurrenceRule | undefined;
}

export interface ScheduleDueMessages {
  readonly bothGiven: string;
  readonly invalidLocalDueTime: string;
  readonly localDueTimeInThePast: string;
}

export interface ScheduleDue {
  readonly dueAt: DateTime.Utc;
  readonly repeat: Repeat | undefined;
}

export const resolveScheduleDue = Effect.fnUntraced(
  function* resolveScheduleDue(
    { localDueTime, repeat }: ScheduleDueRequest,
    timeZone: DateTime.TimeZone.Named,
    messages: ScheduleDueMessages
  ) {
    if (localDueTime !== undefined && repeat !== undefined) {
      return yield* new ToolFailed({ message: messages.bothGiven });
    }
    const now = yield* DateTime.now;
    if (repeat !== undefined) {
      return Option.some<ScheduleDue>({
        dueAt: nextOccurrence(repeat, now, timeZone),
        repeat: { rule: repeat, timeZone },
      });
    }
    if (localDueTime === undefined) {
      return Option.none<ScheduleDue>();
    }
    const dueAt = instantOfLocalDueTime(localDueTime, timeZone);
    if (Option.isNone(dueAt)) {
      return yield* new ToolFailed({ message: messages.invalidLocalDueTime });
    }
    if (DateTime.isLessThanOrEqualTo(dueAt.value, now)) {
      return yield* new ToolFailed({
        message: messages.localDueTimeInThePast,
      });
    }
    return Option.some<ScheduleDue>({
      dueAt: dueAt.value,
      repeat: undefined,
    });
  }
);
