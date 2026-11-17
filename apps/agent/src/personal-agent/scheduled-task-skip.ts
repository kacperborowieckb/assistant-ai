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

interface SkipRecord {
  readonly ownerId: OwnerId;
  readonly event: ScheduleFiredEvent;
  readonly text: string;
  readonly dailyTokenBudget: number;
  readonly tokensSpent: number;
  readonly latencyMillis: number;
}

const recordSkip = Effect.fnUntraced(function* recordSkip({
  ownerId,
  event,
  text,
  dailyTokenBudget,
  tokensSpent,
  latencyMillis,
}: SkipRecord) {
  const traces = yield* TurnTraces;
  const metrics = yield* OperatorMetrics;

  const recorded = yield* traces.readForEvent(event.eventId);
  if (recorded.length > 0) {
    return;
  }
  yield* metrics.record({
    kind: "scheduled_task_skipped",
    ownerId,
    eventId: event.eventId,
    result: "daily_token_budget_spent",
    latencyMillis,
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
});

export const skipScheduledTask = Effect.fnUntraced(function* skipScheduledTask({
  ownerId,
  event,
  action,
  dailyTokenBudget,
  tokensSpent,
  startedAt,
}: SkippedScheduledTask) {
  const journal = yield* Journal;
  const redactor = yield* Redactor;

  const text = scheduledTaskSkipText(redactor.redact(action.prompt));
  yield* journal.append({
    _tag: "ScheduledTaskSkipped",
    eventId: event.eventId,
    scheduleId: event.scheduleId,
    dueAt: event.dueAt,
    dailyTokenBudget,
    tokensSpent,
  });
  yield* recordSkip({
    ownerId,
    event,
    text,
    dailyTokenBudget,
    tokensSpent,
    latencyMillis: (yield* Clock.currentTimeMillis) - startedAt,
  });
  yield* finishSkippedScheduledTask(event, text);
});

export const resumeSkippedScheduledTask = Effect.fnUntraced(
  function* resumeSkippedScheduledTask(
    ownerId: OwnerId,
    event: ScheduleFiredEvent,
    skipped: Pick<SkippedScheduledTask, "dailyTokenBudget" | "tokensSpent">
  ) {
    const schedules = yield* Schedules;
    const redactor = yield* Redactor;

    const schedule = yield* schedules.byId(event.scheduleId);
    if (
      schedule._tag === "None" ||
      schedule.value.action._tag !== "RunPrompt"
    ) {
      return;
    }
    const text = scheduledTaskSkipText(
      redactor.redact(schedule.value.action.prompt)
    );
    yield* recordSkip({ ownerId, event, text, latencyMillis: 0, ...skipped });
    yield* finishSkippedScheduledTask(event, text);
  }
);
