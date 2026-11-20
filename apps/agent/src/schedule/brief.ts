import { DateTime, Effect, Option } from "effect";

import type { Journal } from "../journal/journal.ts";
import { nextOccurrence } from "../time/next-occurrence.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import { briefPrompt } from "./brief-prompt.ts";
import type { Schedules } from "./schedules.ts";

interface BriefServices {
  readonly schedules: Schedules["Service"];
  readonly journal: Journal["Service"];
}

interface BriefRequest {
  readonly timeZone: DateTime.TimeZone.Named;
  readonly localTime: string;
  readonly eventId: string;
}

export const briefScheduleIdOf = Effect.fnUntraced(function* briefScheduleIdOf(
  services: BriefServices
) {
  const { schedules, journal } = services;
  const [created] = yield* journal.readOfKind("BriefCreated");
  if (created?.record._tag === "BriefCreated") {
    return Option.some(created.record.scheduleId);
  }
  return yield* schedules.agentPromptScheduleId(briefPrompt);
});

interface BriefMove {
  readonly oldEnd: string;
  readonly newEnd: string;
  readonly eventId: string;
}

export const moveBriefToNewQuietHoursEnd = Effect.fnUntraced(
  function* moveBriefToNewQuietHoursEnd(
    services: BriefServices,
    { oldEnd, newEnd, eventId }: BriefMove
  ) {
    const { schedules } = services;
    const scheduleId = yield* briefScheduleIdOf(services);
    if (Option.isNone(scheduleId) || oldEnd === newEnd) {
      return false;
    }
    const brief = yield* schedules.byId(scheduleId.value);
    if (Option.isNone(brief)) {
      return false;
    }
    const { state, repeat } = brief.value;
    if (
      state !== "active" ||
      repeat?.rule._tag !== "Daily" ||
      repeat.rule.time !== oldEnd
    ) {
      return false;
    }
    const rule: RecurrenceRule = { _tag: "Daily", time: newEnd };
    const moved = yield* schedules.change({
      scheduleId: scheduleId.value,
      dueAt: nextOccurrence(rule, yield* DateTime.now, repeat.timeZone),
      repeat: { rule, timeZone: repeat.timeZone },
      eventId,
    });
    return Option.isSome(moved);
  }
);

export const ensureBrief = Effect.fnUntraced(function* ensureBrief(
  services: BriefServices,
  { timeZone, localTime, eventId }: BriefRequest
) {
  const { schedules, journal } = services;
  if (yield* journal.hasEntryOfKind("BriefCreated")) {
    return;
  }
  const orphaned = yield* schedules.agentPromptScheduleId(briefPrompt);
  if (Option.isSome(orphaned)) {
    yield* journal.append({
      _tag: "BriefCreated",
      eventId,
      scheduleId: orphaned.value,
    });
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

export const activeBriefScheduleId = Effect.fnUntraced(
  function* activeBriefScheduleId(services: BriefServices) {
    const scheduleId = yield* briefScheduleIdOf(services);
    if (Option.isNone(scheduleId)) {
      return Option.none<string>();
    }
    const brief = yield* services.schedules.byId(scheduleId.value);
    return Option.isSome(brief) && brief.value.state === "active"
      ? scheduleId
      : Option.none<string>();
  }
);
