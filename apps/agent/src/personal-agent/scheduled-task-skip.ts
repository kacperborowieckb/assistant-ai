import { Clock, Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { OwnerId } from "../owner-id.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import { Schedules } from "../schedule/schedules.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { nameOfPrompt } from "./scheduled-task-failure.ts";
import { deliver, recordTurnFailed } from "./turn-delivery.ts";

interface SkippedScheduledTask {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
  readonly dailyTokenBudget: number;
  readonly tokensSpent: number;
  readonly startedAt: number;
}

export const scheduledTaskSkipText = (redactedPrompt: string) =>
  `Your Scheduled Task "${nameOfPrompt(redactedPrompt)}" was skipped because of the daily limit for Scheduled Tasks.`;

export const finishSkippedScheduledTask = Effect.fnUntraced(
  function* finishSkippedScheduledTask(
    event: ScheduleFiredEvent,
    text: string
  ) {
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;

    yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
    const delivery = yield* deliver(event, text);
    if (delivery._tag === "Failed") {
      yield* recordTurnFailed(event, delivery.reason);
      return;
    }
    yield* inbox.markDone([event]);
  }
);

export const skipScheduledTask = Effect.fnUntraced(function* skipScheduledTask({
  ownerId,
  event,
  action,
  dailyTokenBudget,
  tokensSpent,
  startedAt,
}: SkippedScheduledTask) {
  const journal = yield* Journal;
  const traces = yield* TurnTraces;
  const metrics = yield* OperatorMetrics;
  const redactor = yield* Redactor;

  const text = scheduledTaskSkipText(redactor.redact(action.prompt));
  yield* journal.append({
    _tag: "ScheduledTaskSkipped",
    eventId: event.eventId,
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
  });
  yield* traces.record({
    eventId: event.eventId,
    task: "scheduled_task_skip",
    result: "scheduled_task_skipped",
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
    dailyTokenBudget,
    tokensSpent,
    text,
  });
  yield* metrics.record({
    kind: "scheduled_task_skipped",
    ownerId,
    result: "daily_token_budget_spent",
    latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
  });
  yield* finishSkippedScheduledTask(event, text);
});
