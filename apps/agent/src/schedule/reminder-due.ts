import { DateTime, Effect, Option } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { instantOfLocalDueTime } from "../time/local-due-time.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import type { Repeat } from "./schedule.ts";

export interface ReminderDueRequest {
  readonly localDueTime?: string | undefined;
  readonly repeat?: RecurrenceRule | undefined;
}

export interface ReminderDueMessages {
  readonly bothGiven: string;
  readonly invalidLocalDueTime: string;
  readonly localDueTimeInThePast: string;
}

export interface ReminderDue {
  readonly dueAt: DateTime.Utc;
  readonly repeat: Repeat | undefined;
}

export const resolveReminderDue = Effect.fnUntraced(
  function* resolveReminderDue(
    { localDueTime, repeat }: ReminderDueRequest,
    timeZone: DateTime.TimeZone.Named,
    messages: ReminderDueMessages
  ) {
    if (localDueTime !== undefined && repeat !== undefined) {
      return yield* new ToolFailed({ message: messages.bothGiven });
    }
    const now = yield* DateTime.now;
    if (repeat !== undefined) {
      return Option.some<ReminderDue>({
        dueAt: nextOccurrence(repeat, now, timeZone),
        repeat: { rule: repeat, timeZone },
      });
    }
    if (localDueTime === undefined) {
      return Option.none<ReminderDue>();
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
    return Option.some<ReminderDue>({
      dueAt: dueAt.value,
      repeat: undefined,
    });
  }
);
