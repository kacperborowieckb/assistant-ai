import { DateTime, Effect } from "effect";

import type { Journal } from "../journal/journal.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import { briefPrompt } from "./brief-prompt.ts";
import type { Schedules } from "./schedules.ts";

interface BriefRequest {
  readonly timeZone: DateTime.TimeZone.Named;
  readonly localTime: string;
  readonly eventId: string;
}

export const ensureBrief = Effect.fnUntraced(function* ensureBrief(
  services: {
    readonly schedules: Schedules["Service"];
    readonly journal: Journal["Service"];
  },
  { timeZone, localTime, eventId }: BriefRequest
) {
  const { schedules, journal } = services;
  if (yield* schedules.hasAgentPrompt(briefPrompt)) {
    return;
  }
  const rule: RecurrenceRule = { _tag: "Daily", time: localTime };
  const { schedule } = yield* schedules.set({
    action: { _tag: "RunPrompt", prompt: briefPrompt },
    setBy: "agent",
    dueAt: nextOccurrence(rule, yield* DateTime.now, timeZone),
    repeat: { rule, timeZone },
    sourceEventId: eventId,
  });
  yield* journal.append({
    _tag: "BriefCreated",
    eventId,
    scheduleId: schedule.scheduleId,
  });
});
