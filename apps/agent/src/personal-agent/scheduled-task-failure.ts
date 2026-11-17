import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import type { InboxEvent, ScheduleFiredEvent } from "./inbox.ts";
import { honestFailureText, sendHonestFailure } from "./turn-delivery.ts";

const namedPromptLength = 80;

export const nameOfPrompt = (prompt: string) => {
  const oneLine = prompt.replaceAll(/\s+/gu, " ").trim();
  return oneLine.length > namedPromptLength
    ? `${oneLine.slice(0, namedPromptLength)}...`
    : oneLine;
};

export const scheduledTaskFailureText = Effect.fnUntraced(
  function* scheduledTaskFailureText(prompt: string) {
    const redactor = yield* Redactor;
    return `Your Scheduled Task "${nameOfPrompt(redactor.redact(prompt))}" did not run. I could not finish it this time.`;
  }
);

export const honestFailureTextOf = Effect.fnUntraced(
  function* honestFailureTextOf(event: InboxEvent) {
    if (event._tag !== "ScheduleFired") {
      return honestFailureText;
    }
    const schedules = yield* Schedules;
    const schedule = yield* schedules.byId(event.scheduleId);
    return schedule._tag === "Some" &&
      schedule.value.action._tag === "RunPrompt"
      ? yield* scheduledTaskFailureText(schedule.value.action.prompt)
      : honestFailureText;
  }
);

interface FailedScheduledTask {
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
  readonly reason: string;
}

export const failScheduledTask = Effect.fnUntraced(function* failScheduledTask({
  event,
  action,
  reason,
}: FailedScheduledTask) {
  const journal = yield* Journal;
  const schedules = yield* Schedules;

  yield* journal.append({
    _tag: "TurnFailed",
    eventId: event.eventId,
    reason,
  });
  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  yield* sendHonestFailure(
    event,
    yield* scheduledTaskFailureText(action.prompt)
  );
});

export const completeScheduleOfUnsentFailure = Effect.fnUntraced(
  function* completeScheduleOfUnsentFailure(event: ScheduleFiredEvent) {
    const journal = yield* Journal;
    const schedules = yield* Schedules;
    const tags = new Set(
      (yield* journal.readForEvent(event.eventId)).map(
        (entry) => entry.record._tag
      )
    );
    const failureWaitsForSend =
      tags.has("TurnFailed") &&
      !tags.has("SendStarted") &&
      !tags.has("ReplyFailed");
    const schedule = yield* schedules.byId(event.scheduleId);
    if (
      failureWaitsForSend &&
      schedule._tag === "Some" &&
      schedule.value.action._tag === "RunPrompt"
    ) {
      yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    }
  }
);
