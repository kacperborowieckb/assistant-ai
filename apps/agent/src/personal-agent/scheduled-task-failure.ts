import { Effect } from "effect";

import type { RunPrompt } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { Redactor } from "../tracing/redactor.ts";
import {
  honestFailureText,
  recordFailure,
  sendFailureNotice,
} from "./delivery.ts";
import type { InboxEvent, ScheduleFiredEvent } from "./inbox.ts";

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
  const schedules = yield* Schedules;

  yield* recordFailure(event, reason);
  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  yield* sendFailureNotice(
    event,
    yield* scheduledTaskFailureText(action.prompt)
  );
});
