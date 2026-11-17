import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { InboxEvent, ScheduleFiredEvent } from "./inbox.ts";
import { honestFailureText, sendHonestFailure } from "./turn-delivery.ts";

const namedPromptLength = 80;

const nameOfPrompt = (prompt: string) => {
  const oneLine = prompt.replaceAll(/\s+/gu, " ").trim();
  return oneLine.length > namedPromptLength
    ? `${oneLine.slice(0, namedPromptLength)}...`
    : oneLine;
};

export const scheduledTaskFailureText = (prompt: string) =>
  `Your Scheduled Task "${nameOfPrompt(prompt)}" did not run. I could not finish it this time.`;

export const honestFailureTextOf = Effect.fnUntraced(
  function* honestFailureTextOf(event: InboxEvent) {
    if (event._tag !== "ScheduleFired") {
      return honestFailureText;
    }
    const schedules = yield* Schedules;
    const schedule = yield* schedules.byId(event.scheduleId);
    return schedule._tag === "Some" &&
      schedule.value.action._tag === "RunPrompt"
      ? scheduledTaskFailureText(schedule.value.action.prompt)
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
  yield* sendHonestFailure(event, scheduledTaskFailureText(action.prompt));
});
